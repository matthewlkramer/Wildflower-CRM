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
import {
  ORGANIZATION_MERGE_CONFIG,
  PERSON_MERGE_CONFIG,
} from "../lib/mergeEntities";
import { DismissPotentialDuplicateBody } from "@workspace/api-zod";

// Potential-duplicates review queue (admin-only).
//
// On-demand detection of likely-duplicate organizations or people via two
// signals, both computed in the database:
//   • name — pg_trgm similarity over the name (organizations) / full_name
//     (people). The `%` operator is index-accelerated by the *_name_trgm /
//     full_name_trgm GIN indexes; an explicit `similarity() >= threshold` then
//     tightens the cut. (We deliberately do NOT call the deprecated set_limit();
//     the default 0.3 `%` threshold is a superset of our 0.4 floor.) Trigram
//     candidates then pass through a token-level conflict guard (below) that
//     drops pairs whose names differ in distinctive tokens ("MN" vs "US"
//     Department of Education) while keeping mere misspellings.
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

// ─── Token-level name-conflict guard (false-positive filter, name signal) ───
//
// pg_trgm similarity is character-based, so two names that share a long
// generic tail but differ in the short token that actually distinguishes them
// still score high: "MN Department of Education" vs "US Department of
// Education", "State University of New York" vs "City University of New York".
// Those are different real-world entities, not duplicates. After the trigram
// candidate pass we therefore drop pairs whose names CONFLICT at the token
// level:
//   1. tokenize both names (lowercase alphanumeric words, minus a few pure
//      connectives) and remove the tokens shared verbatim;
//   2. greedy-match the leftovers across sides as spelling variants
//      (normalized Levenshtein ≥ TOKEN_SIM_THRESHOLD, or a ≥3-char prefix like
//      "univ" / "university") so misspelled duplicates survive;
//   3. if BOTH sides still hold an unexplained distinctive token, the names
//      disagree about who they are → not a duplicate candidate.
// One-sided leftovers ("MN Department of Education" vs "Department of
// Education") are kept — an added prefix/suffix on the same name is a classic
// duplicate shape. Pairs dropped here can still surface via the shared-phone
// signal (PHONE_ONLY_SCORE), which is a much stronger tie than the name.

const TOKEN_SIM_THRESHOLD = 0.6;
const CONNECTIVE_TOKENS = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "for",
  "in",
  "at",
  "on",
]);

export function tokenizeName(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !CONNECTIVE_TOKENS.has(t));
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

// Two tokens count as the "same word" when one is a ≥3-char prefix of the
// other (abbreviations, plurals: univ/university, school/schools) or their
// normalized Levenshtein similarity clears the threshold (misspellings:
// jon/john, katherine/kathryn). Short distinct tokens (mn/us, a/b initials)
// land well below the threshold and stay distinct.
export function tokensAreSpellingVariants(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length >= 3 && longer.startsWith(shorter)) return true;
  return 1 - levenshtein(a, b) / longer.length >= TOKEN_SIM_THRESHOLD;
}

// ─── Distinct web-identity guard (websites / email domains) ─────────────────
//
// Two records that live on different web domains are different organizations:
// every state has its own Department of Education, each with its own website
// and email domain. For each org we collect a small "domain set" — the
// website host plus the email domains (email_domain, org_email) — normalized
// (protocol / www / path / port stripped) and with free-mail providers
// excluded (a gmail address says nothing about identity). If BOTH sides have
// at least one real domain and the sets share nothing (subdomains of the same
// domain count as shared), the pair is dropped from the name signal. Sharing
// any domain keeps the pair — that is evidence FOR a duplicate. Blank-vs-
// filled stays a candidate, and shared-phone pairs still surface via the
// phone signal.

const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "protonmail.com",
  "proton.me",
  "comcast.net",
]);

// Shared-platform hosts (a Facebook/LinkedIn page URL) say nothing about which
// org it is — two dupes may list facebook.com vs their real domain.
const SHARED_PLATFORM_DOMAINS = new Set([
  "facebook.com",
  "fb.com",
  "linkedin.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "tiktok.com",
  "medium.com",
  "linktr.ee",
  "sites.google.com",
  "wixsite.com",
  "squarespace.com",
  "wordpress.com",
  "blogspot.com",
]);

function isNeutralDomain(host: string): boolean {
  if (FREEMAIL_DOMAINS.has(host)) return true;
  for (const p of SHARED_PLATFORM_DOMAINS) {
    if (host === p || host.endsWith(`.${p}`)) return true;
  }
  return false;
}

/** URL, bare domain, or e-mail address → normalized host (null if unusable). */
export function normalizeWebDomain(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  let v = value.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // Strip path/query/hash BEFORE the @-split so a URL query containing an
  // e-mail (…?email=a@b.com) doesn't hijack the host.
  v = v.split(/[/?#]/)[0]!;
  const at = v.lastIndexOf("@");
  if (at !== -1) v = v.slice(at + 1);
  v = v.split(":")[0]!;
  v = v.replace(/^www\./, "").replace(/\.$/, "");
  if (!v.includes(".")) return null;
  return isNeutralDomain(v) ? null : v;
}

export function orgDomainSet(
  parts: Array<string | null | undefined>,
): Set<string> {
  const out = new Set<string>();
  for (const p of parts) {
    const d = normalizeWebDomain(p);
    if (d) out.add(d);
  }
  return out;
}

// Same identity when equal or one is a subdomain of the other
// (education.mn.gov ↔ mn.gov).
function domainsMatch(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Both sides have real domains and none of them match → different identities. */
export function domainSetsConflict(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const da of a) for (const db of b) if (domainsMatch(da, db)) return false;
  return true;
}

/**
 * True when the two names each carry at least one distinctive token the other
 * side cannot account for (verbatim or as a spelling variant) — i.e. the
 * names identify DIFFERENT things and the pair should not be flagged as a
 * potential duplicate on the name signal alone. Pure / DB-free.
 */
export function namesTokenConflict(nameA: string, nameB: string): boolean {
  const tokensA = tokenizeName(nameA);
  const tokensB = tokenizeName(nameB);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let leftA = [...setA].filter((t) => !setB.has(t));
  let leftB = [...setB].filter((t) => !setA.has(t));
  if (leftA.length === 0 || leftB.length === 0) return false;
  for (const t of [...leftA]) {
    const match = leftB.find((u) => tokensAreSpellingVariants(t, u));
    if (match) {
      leftA = leftA.filter((x) => x !== t);
      leftB = leftB.filter((x) => x !== match);
    }
  }
  return leftA.length > 0 && leftB.length > 0;
}

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
      .select({
        aId: a.id,
        bId: b.id,
        aName: a.name,
        bName: b.name,
        aWebsite: a.website,
        aEmailDomain: a.emailDomain,
        aOrgEmail: a.orgEmail,
        bWebsite: b.website,
        bEmailDomain: b.emailDomain,
        bOrgEmail: b.orgEmail,
        score,
      })
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
    return rows
      .filter((r) => !namesTokenConflict(r.aName ?? "", r.bName ?? ""))
      .filter(
        (r) =>
          !domainSetsConflict(
            orgDomainSet([r.aWebsite, r.aEmailDomain, r.aOrgEmail]),
            orgDomainSet([r.bWebsite, r.bEmailDomain, r.bOrgEmail]),
          ),
      )
      .map((r) => ({ aId: r.aId, bId: r.bId, score: Number(r.score) }));
  }

  const a = alias(people, "a");
  const b = alias(people, "b");
  const score = sql<number>`similarity(${a.fullName}, ${b.fullName})`;
  const rows = await db
    .select({
      aId: a.id,
      bId: b.id,
      aName: a.fullName,
      bName: b.fullName,
      score,
    })
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
  return rows
    .filter((r) => !namesTokenConflict(r.aName ?? "", r.bName ?? ""))
    .map((r) => ({ aId: r.aId, bId: r.bId, score: Number(r.score) }));
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

// Scalar override fields used to decide whether a pair is "safe" to auto-merge.
// These mirror the entity-merge engine's whitelist exactly (imported, never
// re-listed) so safe detection and the merge that follows stay in lockstep.
const SCALAR_FIELDS: Record<EntityType, ReadonlyArray<string>> = {
  organization: ORGANIZATION_MERGE_CONFIG.overrideFields,
  person: PERSON_MERGE_CONFIG.overrideFields,
};

// Load the whitelisted scalar fields for each id so a pair can be compared
// field-by-field. One query; the select set is built from the table columns.
async function loadScalars(
  type: EntityType,
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  if (!ids.length) return new Map();
  const table = type === "organization" ? organizations : people;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cols = table as any;
  const sel: Record<string, unknown> = { id: cols.id };
  for (const f of SCALAR_FIELDS[type]) sel[f] = cols[f];
  const rows = (await db
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select(sel as any)
    .from(table)
    .where(inArray(table.id, ids))) as Array<Record<string, unknown>>;
  return new Map(rows.map((r) => [r.id as string, r]));
}

// Treat null/undefined/empty-string as "no value". Arrays are handled
// separately (they're losslessly unioned by the merge engine).
const normScalar = (v: unknown): unknown =>
  v == null || v === "" ? null : v;

function scalarEq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

export interface MergeSuggestion {
  primaryId: string;
  mergeIds: string[];
  overrides: Record<string, unknown>;
}

/**
 * A pair is "safe" to auto-merge when the two records are identical, or their
 * only differences are a filled value vs null/empty — i.e. NO scalar field
 * holds two distinct non-empty values. (Array columns are skipped: the merge
 * engine unions them, so a difference there is never a conflict.)
 *
 * For a safe pair we also build the exact merge to apply: pick a survivor
 * (more gifts, then older, then id) and, for every field the survivor left
 * empty, take the loser's filled value as an override. Pure / DB-free.
 */
export function computeSafeMerge(
  fields: ReadonlyArray<string>,
  rowA: Record<string, unknown> | undefined,
  rowB: Record<string, unknown> | undefined,
  aId: string,
  bId: string,
  aGifts: number,
  bGifts: number,
  aCreated: Date | null,
  bCreated: Date | null,
): { safe: boolean; suggestion: MergeSuggestion | null } {
  if (!rowA || !rowB) return { safe: false, suggestion: null };

  for (const f of fields) {
    const va = rowA[f];
    const vb = rowB[f];
    if (Array.isArray(va) || Array.isArray(vb)) continue;
    const na = normScalar(va);
    const nb = normScalar(vb);
    if (na !== null && nb !== null && !scalarEq(na, nb)) {
      return { safe: false, suggestion: null };
    }
  }

  // Choose the survivor: most gifts, then earliest createdAt (the original),
  // then the lexicographically smaller id as a deterministic tiebreak.
  let primaryIsA: boolean;
  if (aGifts !== bGifts) {
    primaryIsA = aGifts > bGifts;
  } else if (aCreated && bCreated && aCreated.getTime() !== bCreated.getTime()) {
    primaryIsA = aCreated.getTime() < bCreated.getTime();
  } else if (!!aCreated !== !!bCreated) {
    primaryIsA = !!aCreated;
  } else {
    primaryIsA = aId < bId;
  }

  const primaryId = primaryIsA ? aId : bId;
  const loserId = primaryIsA ? bId : aId;
  const primaryRow = primaryIsA ? rowA : rowB;
  const loserRow = primaryIsA ? rowB : rowA;

  const overrides: Record<string, unknown> = {};
  for (const f of fields) {
    const pv = primaryRow[f];
    const lv = loserRow[f];
    if (Array.isArray(pv) || Array.isArray(lv)) continue;
    if (normScalar(pv) === null && normScalar(lv) !== null) {
      overrides[f] = lv;
    }
  }

  return { safe: true, suggestion: { primaryId, mergeIds: [loserId], overrides } };
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
    const [emailMap, phoneMap, giftMap, scalarMap] = await Promise.all([
      loadPrimaryContact("email", type, finalIds),
      loadPrimaryContact("phone", type, finalIds),
      loadGiftCounts(type, finalIds),
      loadScalars(type, finalIds),
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
      pairs: pairs.map((p) => {
        const { safe, suggestion } = computeSafeMerge(
          SCALAR_FIELDS[type],
          scalarMap.get(p.aId),
          scalarMap.get(p.bId),
          p.aId,
          p.bId,
          giftMap.get(p.aId) ?? 0,
          giftMap.get(p.bId) ?? 0,
          base.get(p.aId)?.createdAt ?? null,
          base.get(p.bId)?.createdAt ?? null,
        );
        return {
          type,
          score: Number(p.score.toFixed(4)),
          signals: [...p.signals],
          a: side(p.aId),
          b: side(p.bId),
          safeMerge: safe,
          mergeSuggestion: suggestion,
        };
      }),
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
