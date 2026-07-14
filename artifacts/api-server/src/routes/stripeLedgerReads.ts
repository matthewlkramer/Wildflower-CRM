import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  donorboxDonations,
  households,
  organizations,
  paymentIntermediaries,
  people,
  settlementLinks,
  stripePayouts,
  stripeStagedCharges,
  giftsAndPayments,
} from "@workspace/db/schema";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  or,
  sql,
} from "drizzle-orm";
import { alias, type PgSelect } from "drizzle-orm/pg-core";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, parsePagination } from "../lib/helpers";
import {
  chargeStatusSql,
  chargeStatusWhere,
} from "../lib/derivedStatus";
import { stripeChargeActiveGiftIdSql } from "../lib/stripeChargeLedger";
import {
  donorboxEnrichmentOrNull,
  donorboxEnrichmentSelect,
} from "../lib/donorboxEnrichment";
import { deriveEvidenceLanes } from "../lib/reconciliationLanes";

const router: IRouter = Router();
const resolvedGift = alias(giftsAndPayments, "ledger_resolved_gift");
const activeGiftId = stripeChargeActiveGiftIdSql(sql`${stripeStagedCharges.id}`);

const queueExpr = sql<string>`CASE
  WHEN ${chargeStatusWhere.excluded} THEN 'excluded'
  WHEN ${chargeStatusWhere.pending} THEN 'needs_review'
  WHEN ${chargeStatusWhere.match_proposed} THEN 'auto_matched'
  ELSE 'done'
END`.as("queue");

// Never expose raw Stripe payloads or retired gift pointers. linked gift fields
// below are derived solely from payment_applications.
const {
  rawCharge: _rawCharge,
  matchedGiftId: _matchedGiftId,
  createdGiftId: _createdGiftId,
  ...chargeColumns
} = getTableColumns(stripeStagedCharges);

const stagedSelect = {
  ...chargeColumns,
  status: chargeStatusSql,
  queue: queueExpr,
  organizationName: organizations.name,
  householdName: households.name,
  individualGiverPersonName: sql<string | null>`COALESCE(
    NULLIF(TRIM(${people.fullName}), ''),
    NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
  )`.as("individual_giver_person_name"),
  intermediaryName: paymentIntermediaries.name,
  resolvedGiftId: resolvedGift.id,
  resolvedGiftName: resolvedGift.name,
  resolvedGiftAmount: resolvedGift.amount,
  resolvedGiftDate: resolvedGift.dateReceived,
  payoutAmount: stripePayouts.amount,
  payoutGrossTotal: stripePayouts.grossTotal,
  payoutFeeTotal: stripePayouts.feeTotal,
  payoutRefundTotal: stripePayouts.refundTotal,
  payoutNetTotal: stripePayouts.netTotal,
  payoutArrivalDate: stripePayouts.arrivalDate,
  payoutStatus: stripePayouts.status,
  payoutQbConflictGiftId: settlementLinks.conflictGiftId,
};

function withJoins<T extends PgSelect>(query: T) {
  return query
    .leftJoin(
      organizations,
      eq(organizations.id, stripeStagedCharges.organizationId),
    )
    .leftJoin(households, eq(households.id, stripeStagedCharges.householdId))
    .leftJoin(
      people,
      eq(people.id, stripeStagedCharges.individualGiverPersonId),
    )
    .leftJoin(
      paymentIntermediaries,
      eq(
        paymentIntermediaries.id,
        stripeStagedCharges.matchedPaymentIntermediaryId,
      ),
    )
    .leftJoin(resolvedGift, sql`${resolvedGift.id} = ${activeGiftId}`)
    .leftJoin(
      stripePayouts,
      eq(stripePayouts.id, stripeStagedCharges.stripePayoutId),
    )
    .leftJoin(
      settlementLinks,
      eq(settlementLinks.payoutId, stripeStagedCharges.stripePayoutId),
    );
}

type Queue =
  | "needs_review"
  | "auto_matched"
  | "excluded"
  | "done"
  | "refund_review";

const STAGED_SORTS = [
  "date_desc",
  "date_asc",
  "amount_desc",
  "amount_asc",
  "payer_asc",
  "payer_desc",
] as const;
type StagedSort = (typeof STAGED_SORTS)[number];

function stagedOrderBy(sort: StagedSort) {
  switch (sort) {
    case "date_asc":
      return [
        asc(stripeStagedCharges.dateReceived),
        desc(stripeStagedCharges.createdAt),
      ];
    case "amount_desc":
      return [
        desc(stripeStagedCharges.grossAmount),
        desc(stripeStagedCharges.createdAt),
      ];
    case "amount_asc":
      return [
        asc(stripeStagedCharges.grossAmount),
        desc(stripeStagedCharges.createdAt),
      ];
    case "payer_asc":
      return [
        asc(stripeStagedCharges.payerName),
        desc(stripeStagedCharges.createdAt),
      ];
    case "payer_desc":
      return [
        desc(stripeStagedCharges.payerName),
        desc(stripeStagedCharges.createdAt),
      ];
    case "date_desc":
    default:
      return [
        desc(stripeStagedCharges.dateReceived),
        desc(stripeStagedCharges.createdAt),
      ];
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function stagedSearchWhere(term: string) {
  const like = `%${escapeLike(term)}%`;
  return or(
    ilike(stripeStagedCharges.payerName, like),
    ilike(stripeStagedCharges.payerEmail, like),
    ilike(stripeStagedCharges.description, like),
    ilike(stripeStagedCharges.statementDescriptor, like),
  );
}

function queueWhere(queue: Queue) {
  switch (queue) {
    case "auto_matched":
      return chargeStatusWhere.match_proposed;
    case "done":
      return chargeStatusWhere.match_confirmed;
    case "excluded":
      return chargeStatusWhere.excluded;
    case "refund_review":
      return eq(stripeStagedCharges.refundPropagationStatus, "proposed");
    case "needs_review":
    default:
      return chargeStatusWhere.pending;
  }
}

router.get(
  "/stripe-staged-charges",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rawQueue =
      typeof req.query["queue"] === "string" ? req.query["queue"] : "";
    const queue: Queue = (
      [
        "needs_review",
        "auto_matched",
        "excluded",
        "done",
        "refund_review",
      ] as const
    ).includes(rawQueue as Queue)
      ? (rawQueue as Queue)
      : "needs_review";
    const rawSort =
      typeof req.query["sort"] === "string" ? req.query["sort"] : "";
    const sort: StagedSort = (STAGED_SORTS as readonly string[]).includes(rawSort)
      ? (rawSort as StagedSort)
      : "date_desc";
    const { limit, offset, page } = parsePagination(req.query);
    const search =
      typeof req.query["search"] === "string"
        ? req.query["search"].trim()
        : "";
    const where = search
      ? and(queueWhere(queue), stagedSearchWhere(search))
      : queueWhere(queue);

    const [rows, totalRow] = await Promise.all([
      withJoins(
        db
          .select({ ...stagedSelect, donorbox: donorboxEnrichmentSelect })
          .from(stripeStagedCharges)
          .$dynamic(),
      )
        .leftJoin(
          donorboxDonations,
          eq(donorboxDonations.stripeChargeId, stripeStagedCharges.id),
        )
        .where(where)
        .orderBy(...stagedOrderBy(sort))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(stripeStagedCharges)
        .where(where)
        .then((result) => result[0]),
    ]);

    res.json({
      data: rows.map((row) => ({
        ...row,
        donorbox: donorboxEnrichmentOrNull(row.donorbox),
        reconciliationLanes: deriveEvidenceLanes({
          status: row.status,
          donorPresent:
            row.organizationId != null ||
            row.individualGiverPersonId != null ||
            row.householdId != null,
          donorConfirmed: row.matchConfirmedAt != null,
          giftLinked:
            row.status === "match_confirmed" && row.resolvedGiftId != null,
          giftProposed:
            row.status === "match_proposed" && row.resolvedGiftId != null,
        }),
      })),
      pagination: { page, limit, total: totalRow?.value ?? 0 },
    });
  }),
);

router.get(
  "/stripe-staged-charges-summary",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const [statusRows, reasonRows, refundReviewRow] = await Promise.all([
      db
        .select({ status: chargeStatusSql, value: count() })
        .from(stripeStagedCharges)
        .groupBy(chargeStatusSql),
      db
        .select({
          reason: stripeStagedCharges.exclusionReason,
          value: count(),
        })
        .from(stripeStagedCharges)
        .where(chargeStatusWhere.excluded)
        .groupBy(stripeStagedCharges.exclusionReason),
      db
        .select({ value: count() })
        .from(stripeStagedCharges)
        .where(queueWhere("refund_review"))
        .then((result) => result[0]),
    ]);

    const byStatus = {
      pending: 0,
      match_proposed: 0,
      match_confirmed: 0,
      excluded: 0,
    };
    for (const row of statusRows) {
      if (row.status in byStatus) {
        byStatus[row.status as keyof typeof byStatus] = row.value;
      }
    }

    const excludedByReason: Record<string, number> = {
      zero_amount: 0,
      loan: 0,
      loan_repayment: 0,
      loan_proceeds: 0,
      note_payable: 0,
      miscoded_withdrawal: 0,
      membership: 0,
      interest: 0,
      government_reimbursement: 0,
      tax_refund: 0,
      other_revenue: 0,
      earned_income: 0,
      fiscally_sponsored: 0,
      intercompany_transfer: 0,
      other: 0,
      insurance: 0,
      expense_refund: 0,
      expensify: 0,
      returned_wire: 0,
    };
    for (const row of reasonRows) {
      if (row.reason) excludedByReason[row.reason] = row.value;
    }

    res.json({
      needsReview: byStatus.pending,
      autoMatched: byStatus.match_proposed,
      done: byStatus.match_confirmed,
      excluded: byStatus.excluded,
      refundReview: refundReviewRow?.value ?? 0,
      excludedByReason,
    });
  }),
);

export default router;
