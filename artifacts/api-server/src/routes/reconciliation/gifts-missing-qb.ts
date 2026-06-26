import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  giftsAndPayments,
  giftAllocations,
  stripeStagedCharges,
  organizations,
  people,
  households,
  entities,
  fundableProjects,
  schools,
} from "@workspace/db/schema";
import { and, asc, count, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { asyncHandler } from "../../lib/helpers";
import { getViewer, maskName } from "../../lib/identityVisibility";
import { escapeLike } from "../quickbooks/shared";
import { qbLedgerExistsForGift } from "../../lib/paymentApplications";

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
    const limit = clampInt(req.query["limit"], 50, 1, 200);
    const offset = clampInt(req.query["offset"], 0, 0, 1_000_000);

    // "Missing a QuickBooks record": the gift has no QuickBooks cash-application
    // ledger row (T003 cutover — the authoritative QB-link signal). The legacy
    // final-amount pointer + scattered staged_payments linkage is subsumed by the
    // ledger (every such pointer is backfilled into a ledger row; the parity gate
    // blocks the cutover on any final-amount pointer with no ledger row).
    const noQbRecord = sql`NOT ${qbLedgerExistsForGift()}`;

    // A gift is Stripe-tied when its money came through Stripe (a final-amount
    // pointer or a staged charge linked to it, or final_amount_source = 'stripe').
    // Such money lands in QuickBooks at the PAYOUT level, not per gift, so the gift
    // never gets a per-gift QB ledger link — it is effectively reconciled, NOT a
    // "missing QB record". Exclude it so the queue stops implying it is unreconciled.
    const isStripeTiedSql = sql<boolean>`(
      ${giftsAndPayments.finalAmountSource} = 'stripe'
      OR ${giftsAndPayments.finalAmountStripeChargeId} IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM ${stripeStagedCharges} sc
        WHERE sc.matched_gift_id = ${giftsAndPayments.id}
      )
    )`;

    // Membership = genuinely UN-reconciled, on-books gift ALLOCATIONS only. One
    // row per gift_allocation (gifts with no allocation surface a single row with
    // a null allocation). A row is listed when:
    //   • the gift has no QuickBooks cash-application ledger row (noQbRecord), AND
    //   • the gift is NOT Stripe-tied (reconciled at the payout level), AND
    //   • the allocation is NOT attributed to an entity that never settles through
    //     a payment processor (entities.expects_payment = false: "Direct to School"
    //     / "Wildflower Foundation TSNE"). Gifts with no allocation, and allocations
    //     with no entity, are kept.
    // This mirrors deriveGiftQbTie's "missing" status at allocation granularity, so
    // the queue never lists money that is exempt or tied as if it were unreconciled.
    const conds: SQL[] = [
      isNull(giftsAndPayments.archivedAt),
      noQbRecord,
      sql`NOT ${isStripeTiedSql}`,
      sql`(${giftAllocations.id} IS NULL OR ${giftAllocations.entityId} IS NULL OR COALESCE(${entities.expectsPayment}, true) = true)`,
    ];

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
      // Per-allocation: only the rows attributed to this entity surface.
      conds.push(eq(giftAllocations.entityId, entityId));
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

    const where = and(...conds);

    // Amount/date to DISPLAY (gift-header context, repeated across the gift's
    // allocation rows). The header amount/date_received can be null on imported or
    // grant records; fall back to allocation data so the row shows meaningful
    // values when the gift has them. Amount → sum of allocation sub-amounts; date →
    // earliest allocation spending-start. Both stay null only when no value exists
    // anywhere. These are read-only display fields; they feed no financial total.
    const displayAmountSql = sql<string | null>`COALESCE(
      ${giftsAndPayments.amount},
      (
        SELECT NULLIF(SUM(ga.sub_amount), 0)
        FROM ${giftAllocations} ga
        WHERE ga.gift_id = ${giftsAndPayments.id}
      )
    )::text`;
    const displayDateSql = sql<string | null>`COALESCE(
      ${giftsAndPayments.dateReceived},
      (
        SELECT MIN(ga.spending_start)
        FROM ${giftAllocations} ga
        WHERE ga.gift_id = ${giftsAndPayments.id}
      )
    )`;

    // The driving table is gift_allocations (LEFT-joined onto gifts so a gift with
    // no allocation still surfaces one row). Entity / fundable-project / school are
    // the ALLOCATION's own scope. Keep the list and count queries in lockstep at
    // this allocation-row granularity.
    const [rows, totalRow] = await Promise.all([
      db
        .select({
          id: giftsAndPayments.id,
          giftName: giftsAndPayments.name,
          allocationId: giftAllocations.id,
          allocationAmount: giftAllocations.subAmount,
          intendedUsage: giftAllocations.intendedUsage,
          displayUsage: giftAllocations.displayUsage,
          fundableProjectId: giftAllocations.fundableProjectId,
          fundableProjectName: fundableProjects.name,
          schoolRecipientId: giftAllocations.schoolRecipientId,
          schoolRecipientName: schools.name,
          grantYear: giftAllocations.grantYear,
          amount: giftsAndPayments.amount,
          displayAmount: displayAmountSql,
          dateReceived: giftsAndPayments.dateReceived,
          displayDate: displayDateSql,
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
          entityId: giftAllocations.entityId,
          entityName: entities.name,
        })
        .from(giftsAndPayments)
        .leftJoin(
          giftAllocations,
          eq(giftAllocations.giftId, giftsAndPayments.id),
        )
        .leftJoin(entities, eq(entities.id, giftAllocations.entityId))
        .leftJoin(
          fundableProjects,
          eq(fundableProjects.id, giftAllocations.fundableProjectId),
        )
        .leftJoin(schools, eq(schools.id, giftAllocations.schoolRecipientId))
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
        .orderBy(
          desc(giftsAndPayments.dateReceived),
          desc(giftsAndPayments.id),
          asc(giftAllocations.id),
        )
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(giftsAndPayments)
        .leftJoin(
          giftAllocations,
          eq(giftAllocations.giftId, giftsAndPayments.id),
        )
        .leftJoin(entities, eq(entities.id, giftAllocations.entityId))
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
        rowKey: `${r.id}:${r.allocationId ?? "none"}`,
        allocationId: r.allocationId,
        giftName: r.giftName,
        donorName,
        donorKind,
        amount: r.amount,
        displayAmount: r.displayAmount,
        allocationAmount: r.allocationAmount,
        dateReceived: r.dateReceived,
        displayDate: r.displayDate,
        paymentMethod: r.paymentMethod,
        entityId: r.entityId,
        entityName: r.entityName,
        intendedUsage: r.intendedUsage,
        displayUsage: r.displayUsage,
        fundableProjectId: r.fundableProjectId,
        fundableProjectName: r.fundableProjectName,
        schoolRecipientId: r.schoolRecipientId,
        schoolRecipientName: r.schoolRecipientName,
        grantYear: r.grantYear,
        finalAmountSource: r.finalAmountSource,
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
