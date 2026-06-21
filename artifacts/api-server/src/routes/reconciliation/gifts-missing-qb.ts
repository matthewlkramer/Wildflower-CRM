import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  giftsAndPayments,
  giftAllocations,
  stagedPayments,
  stripeStagedCharges,
  organizations,
  people,
  households,
  entities,
} from "@workspace/db/schema";
import { and, count, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { asyncHandler } from "../../lib/helpers";
import { getViewer, maskName } from "../../lib/identityVisibility";
import { escapeLike } from "../quickbooks/shared";

const router: IRouter = Router();

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// A real ISO calendar date (YYYY-MM-DD). Format-only checks let "2026-13-40"
// through to the `::date` cast and raise a Postgres 500, so verify the value
// round-trips through Date before we build the query.
function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Allowed gift payment methods (mirrors giftPaymentMethodEnum / the openapi
// GiftPaymentMethod enum) — validated so a bad query param can't raise a
// Postgres "invalid input value for enum" 500 on the enum comparison.
const PAYMENT_METHODS = new Set([
  "ach",
  "check",
  "wire",
  "stock",
  "donor_box",
  "daf_ach",
  "daf_check",
  "daf_bill_com",
]);

// COALESCE(full_name, "first last") — nicer person display than raw full_name.
const personNameSql = sql<string | null>`
  COALESCE(
    NULLIF(TRIM(${people.fullName}), ''),
    NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
  )`;

// ─── GET /reconciliation/gifts-missing-qb ──────────────────────────────────
// The "gifts with no QuickBooks record" stray worklist. Because the main
// reconciliation queue is QB-anchored (one card per QB money event), a gift that
// no QB staged row ever linked to — and that carries no QB final-amount pointer —
// falls through it. User invariant: EVERY gift should eventually have a QB record;
// only SOME (card/online) should ALSO have Stripe. So this list surfaces gifts
// that are missing their QB record for human follow-up. Broad + filterable;
// read-only (no mutation). Donor names are masked per the viewer, same as the
// other list endpoints (match RAW name, mask DISPLAY).
router.get(
  "/reconciliation/gifts-missing-qb",
  asyncHandler(async (req, res) => {
    const viewer = getViewer(req);
    const q = (typeof req.query["q"] === "string" ? req.query["q"] : "").trim();
    const entityId =
      typeof req.query["entityId"] === "string" ? req.query["entityId"] : null;
    const paymentMethodRaw =
      typeof req.query["paymentMethod"] === "string"
        ? req.query["paymentMethod"]
        : null;
    const paymentMethod =
      paymentMethodRaw && PAYMENT_METHODS.has(paymentMethodRaw)
        ? paymentMethodRaw
        : null;
    const dateFrom =
      typeof req.query["dateFrom"] === "string" ? req.query["dateFrom"] : null;
    const dateTo =
      typeof req.query["dateTo"] === "string" ? req.query["dateTo"] : null;
    if (dateFrom && !isValidIsoDate(dateFrom)) {
      res
        .status(400)
        .json({ error: "dateFrom must be a valid YYYY-MM-DD date." });
      return;
    }
    if (dateTo && !isValidIsoDate(dateTo)) {
      res.status(400).json({ error: "dateTo must be a valid YYYY-MM-DD date." });
      return;
    }
    const hasStripeRaw =
      typeof req.query["hasStripe"] === "string"
        ? req.query["hasStripe"]
        : null;
    const limit = clampInt(req.query["limit"], 50, 1, 200);
    const offset = clampInt(req.query["offset"], 0, 0, 1_000_000);

    // "Missing a QuickBooks record": the gift carries no QB final-amount pointer
    // AND no staged_payments row links it (match / mint / group reconcile).
    const noQbRecord = and(
      isNull(giftsAndPayments.finalAmountQbStagedPaymentId),
      sql`NOT EXISTS (
        SELECT 1 FROM ${stagedPayments} sp
        WHERE sp.matched_gift_id = ${giftsAndPayments.id}
           OR sp.created_gift_id = ${giftsAndPayments.id}
           OR sp.group_reconciled_gift_id = ${giftsAndPayments.id}
      )`,
    );

    // Does the gift have Stripe evidence behind it? (final-amount pointer or a
    // staged charge linked to it.) Anomaly signal: Stripe but no QB.
    const hasStripeSql = sql<boolean>`(
      ${giftsAndPayments.finalAmountStripeChargeId} IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM ${stripeStagedCharges} sc
        WHERE sc.matched_gift_id = ${giftsAndPayments.id}
      )
    )`;

    const conds: SQL[] = [isNull(giftsAndPayments.archivedAt), noQbRecord!];

    if (q.length >= 2) {
      const like = `%${escapeLike(q)}%`;
      conds.push(
        or(
          ilike(organizations.name, like),
          ilike(people.fullName, like),
          sql`TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})) ILIKE ${like}`,
          ilike(households.name, like),
        )!,
      );
    }
    if (entityId) {
      conds.push(
        sql`EXISTS (
          SELECT 1 FROM ${giftAllocations} ga
          WHERE ga.gift_id = ${giftsAndPayments.id} AND ga.entity_id = ${entityId}
        )`,
      );
    }
    if (paymentMethod) {
      conds.push(sql`${giftsAndPayments.paymentMethod} = ${paymentMethod}`);
    }
    if (dateFrom) {
      conds.push(sql`${giftsAndPayments.dateReceived} >= ${dateFrom}::date`);
    }
    if (dateTo) {
      conds.push(sql`${giftsAndPayments.dateReceived} <= ${dateTo}::date`);
    }
    if (hasStripeRaw === "true") conds.push(hasStripeSql);
    else if (hasStripeRaw === "false") conds.push(sql`NOT ${hasStripeSql}`);

    const where = and(...conds);

    // A gift's scope (entity) lives on its allocation rows and may span several
    // entities, so aggregate the distinct entity names for display; expose a
    // single entityId only when the gift maps to exactly one entity.
    const entityNamesSql = sql<string | null>`(
      SELECT string_agg(DISTINCT e.name, ', ' ORDER BY e.name)
      FROM ${giftAllocations} ga
      JOIN ${entities} e ON e.id = ga.entity_id
      WHERE ga.gift_id = ${giftsAndPayments.id}
    )`;
    const entityIdSql = sql<string | null>`(
      SELECT CASE WHEN COUNT(DISTINCT ga.entity_id) = 1 THEN MIN(ga.entity_id) END
      FROM ${giftAllocations} ga
      WHERE ga.gift_id = ${giftsAndPayments.id} AND ga.entity_id IS NOT NULL
    )`;

    const [rows, totalRow] = await Promise.all([
      db
        .select({
          id: giftsAndPayments.id,
          amount: giftsAndPayments.amount,
          dateReceived: giftsAndPayments.dateReceived,
          paymentMethod: giftsAndPayments.paymentMethod,
          finalAmountSource: giftsAndPayments.finalAmountSource,
          organizationId: giftsAndPayments.organizationId,
          individualGiverPersonId: giftsAndPayments.individualGiverPersonId,
          householdId: giftsAndPayments.householdId,
          organizationName: organizations.name,
          organizationAnonymous: organizations.anonymous,
          organizationOwnerUserId: organizations.ownerUserId,
          personName: personNameSql,
          personAnonymous: people.anonymous,
          personOwnerUserId: people.ownerUserId,
          householdName: households.name,
          entityId: entityIdSql,
          entityName: entityNamesSql,
          hasStripeEvidence: hasStripeSql,
        })
        .from(giftsAndPayments)
        .leftJoin(
          organizations,
          eq(organizations.id, giftsAndPayments.organizationId),
        )
        .leftJoin(
          people,
          eq(people.id, giftsAndPayments.individualGiverPersonId),
        )
        .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
        .where(where)
        .orderBy(desc(giftsAndPayments.dateReceived), desc(giftsAndPayments.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(giftsAndPayments)
        .leftJoin(
          organizations,
          eq(organizations.id, giftsAndPayments.organizationId),
        )
        .leftJoin(
          people,
          eq(people.id, giftsAndPayments.individualGiverPersonId),
        )
        .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
        .where(where)
        .then((r) => r[0]),
    ]);

    const data = rows.map((r) => {
      let donorName: string | null = null;
      let donorKind: "organization" | "person" | "household" | null = null;
      if (r.organizationId) {
        donorKind = "organization";
        donorName = maskName(
          r.organizationName,
          {
            anonymous: r.organizationAnonymous,
            ownerUserId: r.organizationOwnerUserId,
          },
          viewer,
        );
      } else if (r.individualGiverPersonId) {
        donorKind = "person";
        donorName = maskName(
          r.personName,
          {
            anonymous: r.personAnonymous,
            ownerUserId: r.personOwnerUserId,
          },
          viewer,
        );
      } else if (r.householdId) {
        donorKind = "household";
        donorName = r.householdName;
      }
      return {
        id: r.id,
        donorName,
        donorKind,
        amount: r.amount,
        dateReceived: r.dateReceived,
        paymentMethod: r.paymentMethod,
        entityId: r.entityId,
        entityName: r.entityName,
        finalAmountSource: r.finalAmountSource,
        hasStripeEvidence: Boolean(r.hasStripeEvidence),
      };
    });

    res.json({
      data,
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        total: totalRow?.value ?? 0,
      },
    });
  }),
);

export default router;
