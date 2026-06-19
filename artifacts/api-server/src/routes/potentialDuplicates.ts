import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  organizations,
  people,
  users,
  emails,
  phoneNumbers,
  giftsAndPayments,
  duplicateDismissals,
} from "@workspace/db/schema";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { asyncHandler, newId, parseOrBadRequest } from "../lib/helpers";
import { requireAuth } from "../middlewares/requireAuth";
import { requireAdmin } from "../lib/archive";
import { getAppUser } from "../lib/appRequest";
import { getViewer, maskName, type Viewer } from "../lib/identityVisibility";
import { DismissPotentialDuplicateBody } from "@workspace/api-zod";

// Potential-duplicates review queue (admin-only).
//
// On-demand detection of likely-duplicate organizations or people via two
// signals, both computed in the database:
//   • name — pg_trgm similarity over the name (organizations) / full_name
//     (people). The `%` operator is index-accelerated by the *_name_trgm /
//     full_name_trgm GIN indexes; an explicit `similarity() >= threshold` then
//     tightens the cut. (We deliberately do NOT call the deprecated set_limit();
//     the default 0.3 `%` threshold is a superset of our 0.4 floor.)
//   • phone — two distinct entities that share a normalized (digits-only) phone
//     number of at least MIN_PHONE_DIGITS digits.
//
// Pairs are stored in a canonical order (idA < idB) so each shows up once. Pairs
// an admin has dismissed (duplicate_dismissals) are excluded, and only active
// (non-archived) records are considered. Emails are globally unique, so a shared
// email can never indicate a duplicate — it is intentionally not a signal.
//
// Names are anonymous-masked defensively even though the route is admin-only
// (admins always see identities, so this is a no-op for them).

const router: IRouter = Router();
router.use(requireAuth);

type EntityType = "organization" | "person";

const NAME_SIM_THRESHOLD = 0.4;
const PHONE_BONUS = 0.5;
const PHONE_ONLY_SCORE = 0.85;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MIN_PHONE_DIGITS = 7;

const keyOf = (a: string, b: string) => `${a}|${b}`;

// Human-readable owner label: display name, then first+last, then email.
const ownerNameExpr = sql<string | null>`COALESCE(
  NULLIF(${users.displayName}, ''),
  NULLIF(TRIM(CONCAT_WS(' ', ${users.firstName}, ${users.lastName})), ''),
  ${users.email}
)`;

interface NamePair {
  aId: string;
  bId: string;
  score: number;
}

// Trigram self-join over the name column, canonical order (a.id < b.id), active
// only, dismissed pairs excluded in-SQL so they never consume candidate slots.
async function detectNamePairs(
  type: EntityType,
  limit: number,
): Promise<NamePair[]> {
  if (type === "organization") {
    const a = alias(organizations, "a");
    const b = alias(organizations, "b");
    const score = sql<number>`similarity(${a.name}, ${b.name})`;
    const rows = await db
      .select({ aId: a.id, bId: b.id, score })
      .from(a)
      .innerJoin(
        b,
        and(
          sql`${a.id} < ${b.id}`,
          sql`${a.name} % ${b.name}`,
          sql`similarity(${a.name}, ${b.name}) >= ${NAME_SIM_THRESHOLD}`,
        ),
      )
      .where(
        and(
          isNull(a.archivedAt),
          isNull(b.archivedAt),
          sql`NOT EXISTS (SELECT 1 FROM duplicate_dismissals d WHERE d.entity_type = ${type} AND d.id_a = ${a.id} AND d.id_b = ${b.id})`,
        ),
      )
      .orderBy(desc(score))
      .limit(limit);
    return rows.map((r) => ({ aId: r.aId, bId: r.bId, score: Number(r.score) }));
  }

  const a = alias(people, "a");
  const b = alias(people, "b");
  const score = sql<number>`similarity(${a.fullName}, ${b.fullName})`;
  const rows = await db
    .select({ aId: a.id, bId: b.id, score })
    .from(a)
    .innerJoin(
      b,
      and(
        sql`${a.id} < ${b.id}`,
        sql`${a.fullName} % ${b.fullName}`,
        sql`similarity(${a.fullName}, ${b.fullName}) >= ${NAME_SIM_THRESHOLD}`,
      ),
    )
    .where(
      and(
        isNull(a.archivedAt),
        isNull(b.archivedAt),
        sql`NOT EXISTS (SELECT 1 FROM duplicate_dismissals d WHERE d.entity_type = ${type} AND d.id_a = ${a.id} AND d.id_b = ${b.id})`,
      ),
    )
    .orderBy(desc(score))
    .limit(limit);
  return rows.map((r) => ({ aId: r.aId, bId: r.bId, score: Number(r.score) }));
}

// Pairs of distinct entities sharing a normalized phone number. Not filtered for
// archived/dismissed here (phone_numbers is small); the caller applies those via
// the active base map + loadDismissed.
async function detectPhonePairs(
  type: EntityType,
): Promise<{ aId: string; bId: string }[]> {
  const p1 = alias(phoneNumbers, "p1");
  const p2 = alias(phoneNumbers, "p2");
  const col1 = type === "organization" ? p1.organizationId : p1.personId;
  const col2 = type === "organization" ? p2.organizationId : p2.personId;
  const norm1 = sql`regexp_replace(${p1.phoneNumber}, '\D', '', 'g')`;
  const norm2 = sql`regexp_replace(${p2.phoneNumber}, '\D', '', 'g')`;
  const rows = await db
    .select({ aId: col1, bId: col2 })
    .from(p1)
    .innerJoin(p2, and(sql`${norm1} = ${norm2}`, sql`${col1} < ${col2}`))
    .where(
      and(
        sql`${col1} IS NOT NULL`,
        sql`${col2} IS NOT NULL`,
        sql`length(${norm1}) >= ${MIN_PHONE_DIGITS}`,
      ),
    )
    // One row per entity pair even when they share multiple phone numbers, so
    // the PHONE_BONUS is only ever applied once per pair downstream.
    .groupBy(col1, col2);
  return rows
    .filter((r) => r.aId != null && r.bId != null)
    .map((r) => ({ aId: r.aId as string, bId: r.bId as string }));
}

interface BaseSide {
  name: string | null;
  anonymous: boolean | null;
  ownerUserId: string | null;
  ownerName: string | null;
  createdAt: Date | null;
}

// Base fields for the given ids, ACTIVE rows only — membership in this map
// doubles as the "is active (non-archived)" check for phone-only candidates.
async function loadBase(
  type: EntityType,
  ids: string[],
): Promise<Map<string, BaseSide>> {
  if (!ids.length) return new Map();
  if (type === "organization") {
    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        anonymous: organizations.anonymous,
        ownerUserId: organizations.ownerUserId,
        ownerName: ownerNameExpr,
        createdAt: organizations.createdAt,
      })
      .from(organizations)
      .leftJoin(users, eq(users.id, organizations.ownerUserId))
      .where(
        and(inArray(organizations.id, ids), isNull(organizations.archivedAt)),
      );
    return new Map(rows.map((r) => [r.id, r]));
  }
  const rows = await db
    .select({
      id: people.id,
      name: people.fullName,
      anonymous: people.anonymous,
      ownerUserId: people.ownerUserId,
      ownerName: ownerNameExpr,
      createdAt: people.createdAt,
    })
    .from(people)
    .leftJoin(users, eq(users.id, people.ownerUserId))
    .where(and(inArray(people.id, ids), isNull(people.archivedAt)));
  return new Map(rows.map((r) => [r.id, r]));
}

// Preferred-first contact value (email or phone) per entity id.
async function loadPrimaryContact(
  kind: "email" | "phone",
  type: EntityType,
  ids: string[],
): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  if (kind === "email") {
    const owner =
      type === "organization" ? emails.organizationId : emails.personId;
    const rows = await db
      .selectDistinctOn([owner], { id: owner, value: emails.email })
      .from(emails)
      .where(inArray(owner, ids))
      .orderBy(owner, desc(emails.isPreferred), asc(emails.createdAt));
    return new Map(
      rows.filter((r) => r.id != null).map((r) => [r.id as string, r.value]),
    );
  }
  const owner =
    type === "organization"
      ? phoneNumbers.organizationId
      : phoneNumbers.personId;
  const rows = await db
    .selectDistinctOn([owner], { id: owner, value: phoneNumbers.phoneNumber })
    .from(phoneNumbers)
    .where(inArray(owner, ids))
    .orderBy(owner, desc(phoneNumbers.isPreferred), asc(phoneNumbers.createdAt));
  return new Map(
    rows.filter((r) => r.id != null).map((r) => [r.id as string, r.value]),
  );
}

// Count of non-archived gifts attributed to each entity id (a disambiguation
// hint — mirrors the analytics convention of excluding archived gifts).
async function loadGiftCounts(
  type: EntityType,
  ids: string[],
): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const owner =
    type === "organization"
      ? giftsAndPayments.organizationId
      : giftsAndPayments.individualGiverPersonId;
  const rows = await db
    .select({ id: owner, c: count() })
    .from(giftsAndPayments)
    .where(and(inArray(owner, ids), isNull(giftsAndPayments.archivedAt)))
    .groupBy(owner);
  return new Map(
    rows.filter((r) => r.id != null).map((r) => [r.id as string, Number(r.c)]),
  );
}

// Dismissed (entity_type, idA, idB) keys among the candidate ids.
async function loadDismissed(
  type: EntityType,
  ids: string[],
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db
    .select({ idA: duplicateDismissals.idA, idB: duplicateDismissals.idB })
    .from(duplicateDismissals)
    .where(
      and(
        eq(duplicateDismissals.entityType, type),
        inArray(duplicateDismissals.idA, ids),
        inArray(duplicateDismissals.idB, ids),
      ),
    );
  return new Set(rows.map((r) => keyOf(r.idA, r.idB)));
}

function parseType(raw: unknown): EntityType | null {
  return raw === "organization" || raw === "person" ? raw : null;
}

router.get(
  "/potential-duplicates",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const type = parseType(req.query["type"]);
    if (!type) {
      res.status(400).json({
        error: "validation_error",
        message: "type must be 'organization' or 'person'.",
      });
      return;
    }

    const rawLimit = Number(req.query["limit"]);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)))
      : DEFAULT_LIMIT;
    // Over-fetch name candidates so a phone bonus can still reorder the top N.
    const candidateLimit = Math.min(MAX_LIMIT * 2, limit * 4);

    const [namePairs, phonePairs] = await Promise.all([
      detectNamePairs(type, candidateLimit),
      detectPhonePairs(type),
    ]);

    const merged = new Map<
      string,
      { aId: string; bId: string; score: number; signals: Set<string> }
    >();
    for (const p of namePairs) {
      merged.set(keyOf(p.aId, p.bId), {
        aId: p.aId,
        bId: p.bId,
        score: p.score,
        signals: new Set(["name"]),
      });
    }
    for (const p of phonePairs) {
      const k = keyOf(p.aId, p.bId);
      const existing = merged.get(k);
      if (existing) {
        existing.score += PHONE_BONUS;
        existing.signals.add("phone");
      } else {
        merged.set(k, {
          aId: p.aId,
          bId: p.bId,
          score: PHONE_ONLY_SCORE,
          signals: new Set(["phone"]),
        });
      }
    }

    let pairs = [...merged.values()];

    // Drop pairs touching an archived/missing record (loadBase returns active
    // rows only) or dismissed by an admin. Name pairs are already SQL-filtered;
    // this is what enforces it for phone-only pairs.
    const candidateIds = [
      ...new Set(pairs.flatMap((p) => [p.aId, p.bId])),
    ];
    const [base, dismissed] = await Promise.all([
      loadBase(type, candidateIds),
      loadDismissed(type, candidateIds),
    ]);
    pairs = pairs.filter(
      (p) =>
        base.has(p.aId) &&
        base.has(p.bId) &&
        !dismissed.has(keyOf(p.aId, p.bId)),
    );

    pairs.sort((x, y) => y.score - x.score);
    pairs = pairs.slice(0, limit);

    const finalIds = [...new Set(pairs.flatMap((p) => [p.aId, p.bId]))];
    const [emailMap, phoneMap, giftMap] = await Promise.all([
      loadPrimaryContact("email", type, finalIds),
      loadPrimaryContact("phone", type, finalIds),
      loadGiftCounts(type, finalIds),
    ]);

    const viewer: Viewer = getViewer(req);
    const side = (id: string) => {
      const b = base.get(id)!;
      return {
        id,
        name:
          maskName(
            b.name,
            { anonymous: b.anonymous, ownerUserId: b.ownerUserId },
            viewer,
          ) ?? "(no name)",
        ownerName: b.ownerName ?? null,
        primaryEmail: emailMap.get(id) ?? null,
        primaryPhone: phoneMap.get(id) ?? null,
        createdAt: b.createdAt ? b.createdAt.toISOString() : null,
        giftCount: giftMap.get(id) ?? 0,
      };
    };

    res.json({
      pairs: pairs.map((p) => ({
        type,
        score: Number(p.score.toFixed(4)),
        signals: [...p.signals],
        a: side(p.aId),
        b: side(p.bId),
      })),
    });
  }),
);

router.post(
  "/potential-duplicates/dismiss",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const body = parseOrBadRequest(DismissPotentialDuplicateBody, req.body, res);
    if (!body) return;

    let { idA, idB } = body;
    if (idA === idB) {
      res.status(400).json({
        error: "validation_error",
        message: "idA and idB must reference two different records.",
      });
      return;
    }
    // Canonicalize so a pair is recorded once regardless of argument order.
    if (idA > idB) [idA, idB] = [idB, idA];

    await db
      .insert(duplicateDismissals)
      .values({
        id: newId(),
        entityType: body.type,
        idA,
        idB,
        dismissedByUserId: getAppUser(req)?.id ?? null,
      })
      .onConflictDoNothing();

    res.status(204).end();
  }),
);

export default router;
