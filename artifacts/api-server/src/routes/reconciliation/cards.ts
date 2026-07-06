import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  settlementLinks,
  stagedPayments,
  stagedPaymentExclusionReasonEnum,
  stripePayouts,
  stripeStagedCharges,
} from "@workspace/db/schema";
import { and, asc, eq, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { opportunitiesAndPledges } from "@workspace/db/schema";
import {
  qbLedgerExistsForGiftExcludingPayment,
  chargeIdOwningGiftExcludingCharge,
} from "../../lib/paymentApplications";
import { asyncHandler, notFound } from "../../lib/helpers";
import { getViewer } from "../../lib/identityVisibility";
import { buildReconciliationGraph } from "../../lib/reconciliationGraph";
import {
  giftMatchAmountBounds,
  giftMatchAmountBoundsKnownNet,
  GIFT_MATCH_WINDOW_DAYS,
} from "../../lib/giftMatch";
import { deriveEvidenceLanes } from "../../lib/reconciliationLanes";
import { isQbGroupMemberSql } from "../../lib/unitGroupMembership";
import { payoutStatusLabelSql } from "../../lib/settlementLink";
import {
  entityWhere,
  isParkedFiscallyRow,
  queueWhere,
  resolvedGift,
  stagedOrderBy,
  stagedSearchWhere,
  stagedSelect,
  withJoins,
  type Queue,
} from "../quickbooks/shared";

const router: IRouter = Router();

// The opportunity the resolved gift pays down (its pledge), surfaced read-only
// on each card so a reconciled row shows the closed graph at a glance.
const recCardOpp = alias(opportunitiesAndPledges, "rec_card_opp");

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// A candidate gift counts as a high-confidence auto-match only when its date is
// within "a few months" of the staged payment. This is the bulk-approval card
// hint (count / auto-pick / ready all share this pool, so they stay aligned);
// the sync-time matcher (quickbooksMatch.GIFT_WINDOW_DAYS) stays stricter at 60.
// Strict NULL handling: a missing date on either side can't be claimed as
// "within a few months", so it is excluded from this high-confidence pool (it
// can still be matched by hand on the card).
const READY_GIFT_DATE_WINDOW_DAYS = GIFT_MATCH_WINDOW_DAYS;

// Unlinked, same-donor, date-proximate gifts for the staged row's SAVED donor —
// the auto-proposal pool for the card's gift node. "Unlinked" = not
// matched/created by another staged payment and not used in another row's split.
// Mirrors the legacy giftAlreadyLinkedElsewhere logic so the card and the queue
// agree. The amount band is THE shared matcher (giftMatchAmountBounds):
//   - band "proposal" → WIDENED donor-scoped band (safe: the pool is already one
//     donor's own gifts) so a gift booked under the Stripe gross still surfaces;
//     this feeds the card's "match vs create gift" proposal + the graph search.
//   - band "strict"   → the approve gate's exact band (amountWithinFeeBand),
//     used ONLY by the ready/bulk-approve hint so the ready set can never exceed
//     the gate-passing set (a $920 gift on a $1000 QB check PROPOSES but is NOT
//     one-click ready — it needs the amount-mismatch override at approve).
function unlinkedDonorGiftWhere(band: "proposal" | "strict" = "proposal"): SQL {
  return sql`(
    (${stagedPayments.organizationId} IS NOT NULL AND g.organization_id = ${stagedPayments.organizationId})
    OR (${stagedPayments.individualGiverPersonId} IS NOT NULL AND g.individual_giver_person_id = ${stagedPayments.individualGiverPersonId})
    OR (${stagedPayments.householdId} IS NOT NULL AND g.household_id = ${stagedPayments.householdId})
  )
  AND ${stagedPayments.amount} IS NOT NULL
  AND ${giftMatchAmountBounds(sql.raw("g.amount"), sql`${stagedPayments.amount}::numeric`, band === "proposal")}
  AND g.archived_at IS NULL
  AND ${stagedPayments.dateReceived} IS NOT NULL
  AND g.date_received IS NOT NULL
  AND ABS(g.date_received - ${stagedPayments.dateReceived}) <= ${READY_GIFT_DATE_WINDOW_DAYS}
  AND NOT ${qbLedgerExistsForGiftExcludingPayment(
    sql.raw("g.id"),
    sql.raw('"staged_payments"."id"'),
  )}`;
}

const autoGiftCountExpr = sql<number>`(
  SELECT COUNT(*)::int FROM gifts_and_payments g WHERE ${unlinkedDonorGiftWhere()}
)`;

const autoGiftPickExpr = sql<{
  id: string;
  name: string | null;
  dateReceived: string | null;
} | null>`(
  SELECT jsonb_build_object(
    'id', g.id,
    'name', g.name,
    'dateReceived', g.date_received::text
  )
  FROM gifts_and_payments g WHERE ${unlinkedDonorGiftWhere()}
  ORDER BY ABS(g.amount - ${stagedPayments.amount}::numeric) ASC
  LIMIT 1
)`;

// A row is auto-ready when it is pending, its donor is a confirmed single match,
// and exactly one unlinked gift exists to tie it to — counted with the STRICT
// band so the ready set equals the approve gate's pass set (amountWithinFeeBand).
// The proposal pool above may be WIDER (it can surface an under-gross gift to
// PROPOSE), but a widened-only match is never one-click ready; it needs the
// gate's amount-mismatch override at approve. (The full consistency gate still
// runs server-side at approve; this is the cheap list hint.)
const readyExpr = sql<boolean>`(
  ${stagedPayments.status} = 'pending'
  AND ${stagedPayments.matchStatus} = 'matched'
  AND num_nonnulls(${stagedPayments.organizationId}, ${stagedPayments.individualGiverPersonId}, ${stagedPayments.householdId}) = 1
  AND (SELECT COUNT(*)::int FROM gifts_and_payments g WHERE ${unlinkedDonorGiftWhere("strict")}) = 1
)`;

// The charge-anchor analogue of unlinkedDonorGiftWhere: unlinked, same-donor,
// date-proximate gifts for a Stripe CHARGE's own donor + KNOWN-NET amount band.
// The known-net band [min(net,gross)-0.01, max(net,gross)+0.01] equals the
// approve gate's window for a charge, so a proposal it surfaces is always
// resolvable (never a phantom "create gift" for a gift booked under the gross,
// e.g. a $104.00 gift behind a $104.42 charge). "Unlinked" here excludes ONLY
// gifts already owned by ANOTHER charge — a gift a QuickBooks payment already
// booked is PARALLEL evidence for the same money and must still match. Used only
// inside the chargeSub lateral, so it correlates on the real
// stripe_staged_charges columns (never the subquery's own aliased outputs).
function unlinkedChargeGiftWhere(): SQL {
  return sql`(
    (${stripeStagedCharges.organizationId} IS NOT NULL AND g.organization_id = ${stripeStagedCharges.organizationId})
    OR (${stripeStagedCharges.individualGiverPersonId} IS NOT NULL AND g.individual_giver_person_id = ${stripeStagedCharges.individualGiverPersonId})
    OR (${stripeStagedCharges.householdId} IS NOT NULL AND g.household_id = ${stripeStagedCharges.householdId})
  )
  AND ${stripeStagedCharges.grossAmount} IS NOT NULL
  AND ${stripeStagedCharges.netAmount} IS NOT NULL
  AND ${giftMatchAmountBoundsKnownNet(
    sql.raw("g.amount"),
    sql`${stripeStagedCharges.grossAmount}`,
    sql`${stripeStagedCharges.netAmount}`,
  )}
  AND g.archived_at IS NULL
  AND ${stripeStagedCharges.dateReceived} IS NOT NULL
  AND g.date_received IS NOT NULL
  AND ABS(g.date_received - ${stripeStagedCharges.dateReceived}) <= ${GIFT_MATCH_WINDOW_DAYS}
  AND ${chargeIdOwningGiftExcludingCharge(
    sql.raw("g.id"),
    sql`${stripeStagedCharges.id}`,
  )} IS NULL`;
}

const stripeEvidenceExpr = sql<{
  payoutId: string;
  chargeCount: number;
  reconciliationStatus: string | null;
  charge: {
    grossAmount: string | null;
    netAmount: string | null;
    feeAmount: string | null;
    payerName: string | null;
  } | null;
} | null>`(
  SELECT jsonb_build_object(
    'payoutId', p.id,
    'chargeCount', (
      SELECT COUNT(*)::int FROM stripe_staged_charges c WHERE c.stripe_payout_id = p.id
    ),
    'reconciliationStatus', ${payoutStatusLabelSql},
    -- The single backing charge's money + payer, but ONLY when exactly one
    -- charge backs the payout (MIN collapses that lone row; COUNT<>1 → NULL),
    -- so multi-charge payouts never show one charge's donor as the whole.
    'charge', (
      SELECT CASE WHEN COUNT(*) = 1 THEN jsonb_build_object(
        'grossAmount', MIN(c.gross_amount)::text,
        'netAmount',   MIN(c.net_amount)::text,
        'feeAmount',   MIN(c.fee_amount)::text,
        'payerName',   MIN(c.payer_name)
      ) ELSE NULL END
      FROM stripe_staged_charges c WHERE c.stripe_payout_id = p.id
    )
  )
  FROM stripe_payouts p
  JOIN settlement_links sl ON sl.payout_id = p.id
  WHERE sl.deposit_staged_payment_id = ${stagedPayments.id}
  LIMIT 1
)`;

// Collapse a manual "same physical gift" group into ONE card: only the group's
// representative row (the min id among members, compared byte-wise via COLLATE
// "C" so it matches the approve route's JS code-unit sort) is returned; ungrouped
// rows (no unit_group_members membership) always pass. Membership now lives in
// `unit_group_members` (evidence_source='quickbooks', source_id = staged id), not
// the retired `staged_payments.source_group_id`. Applied to BOTH the page query
// and the count so the pagination total is per-group.
const groupRepresentativeWhere: SQL = sql`(
  NOT ${isQbGroupMemberSql()}
  OR ${stagedPayments.id} = (
    SELECT MIN(m2.source_id COLLATE "C")
    FROM unit_group_members m1
    JOIN unit_group_members m2
      ON m2.group_id = m1.group_id AND m2.evidence_source = 'quickbooks'
    WHERE m1.evidence_source = 'quickbooks'
      AND m1.source_id = ${stagedPayments.id}
  )
)`;

// Group rollup for a representative card: member count, summed amount, the
// members' COMMON funding source/provenance (null when they disagree), and a
// compact per-member list (ordered by the same COLLATE "C" key so the first is
// the representative). Null for an ungrouped row. The outer staged_payments row
// is correlated into the subquery as the group key.
const sourceGroupAggExpr = sql<{
  count: number;
  totalAmount: string;
  commonFundingSource: string | null;
  commonProvenance: string | null;
  members: Array<{
    stagedPaymentId: string;
    amount: string | null;
    dateReceived: string | null;
    payerName: string | null;
    qbDocNumber: string | null;
    fundingSource: string | null;
  }>;
} | null>`(
  CASE
    WHEN NOT ${isQbGroupMemberSql()} THEN NULL
    ELSE (
      SELECT jsonb_build_object(
        'count', COUNT(*)::int,
        'totalAmount', COALESCE(SUM(m.amount), 0)::text,
        'commonFundingSource',
          CASE WHEN COUNT(*) = COUNT(m.funding_source)
                AND COUNT(DISTINCT m.funding_source) = 1
               THEN MIN(m.funding_source) ELSE NULL END,
        'commonProvenance',
          CASE WHEN COUNT(DISTINCT m.funding_source_provenance) = 1
               THEN MIN(m.funding_source_provenance) ELSE NULL END,
        'members', COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'stagedPaymentId', m.id,
              'amount', m.amount::text,
              'dateReceived', m.date_received::text,
              'payerName', m.payer_name,
              'qbDocNumber', m.qb_doc_number,
              'fundingSource', m.funding_source
            ) ORDER BY m.id COLLATE "C"
          ),
          '[]'::jsonb
        )
      )
      FROM staged_payments m
      JOIN unit_group_members mem
        ON mem.source_id = m.id AND mem.evidence_source = 'quickbooks'
      WHERE mem.group_id = (
        SELECT g.group_id FROM unit_group_members g
        WHERE g.evidence_source = 'quickbooks'
          AND g.source_id = ${stagedPayments.id}
        LIMIT 1
      )
    )
  END
)`;

// Default reconciliation queue: the live work. `pending` rows are work UNLESS
// they are attributed to a fiscally sponsored entity — that money is pass-through
// for a sponsored project, so it is PARKED out of the main flow and only shown
// when the caller explicitly asks for queue=fiscally_sponsored (matchable later,
// never cluttering day-to-day reconciliation). The NULL entity_id (Foundation
// default) must stay IN — `entity_id NOT IN (...)` is NULL-unsafe, so guard it
// explicitly with an IS NULL branch.
// `approved` rows came from the LEGACY /staged-payments flow and already minted
// (createdGiftId) or linked (matchedGiftId) a gift. Such an already-approved
// QB↔gift link is DONE and should "stay approved" — it only re-enters this queue
// when there is still Stripe to tie in (a payout matched/proposed to it). So an
// approved row is excluded iff it has a gift link AND no Stripe to link;
// otherwise (no gift, or Stripe pending) it stays as real work.
// `reconciled` deposits are normally terminal, EXCEPT a Stripe-payout deposit
// whose payout↔deposit settlement has been confirmed (Plane 1) but whose backing
// charges are not yet all credited to gifts (Plane 2). The settlement report now
// confirms ONLY the settlement link, marking the deposit `reconciled` while
// leaving per-charge crediting to the gift report — so such a deposit must stay
// in the live queue until every charge is tied, or the unbooked charges would be
// invisible/unbookable (silent under-credit). The lateral charge expansion +
// unresolved-charge filter below collapse it to just its unbooked charge cards
// and drop it once the last charge books. Any other named bucket reuses the
// legacy mapping (which includes the fiscally_sponsored parking queue itself).
function reconciliationQueueWhere(queue: string | undefined): SQL | undefined {
  if (!queue || queue === "all")
    return sql`(
      (
        ${stagedPayments.status} = 'pending'
        AND (${stagedPayments.entityId} IS NULL OR NOT (${isParkedFiscallyRow}))
      )
      OR (
        ${stagedPayments.status} = 'approved'
        AND NOT (
          (${stagedPayments.matchedGiftId} IS NOT NULL OR ${stagedPayments.createdGiftId} IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM settlement_links sl
            WHERE sl.deposit_staged_payment_id = ${stagedPayments.id}
          )
        )
      )
      OR (
        ${stagedPayments.status} = 'reconciled'
        -- Re-admit for per-charge crediting ONLY a SETTLEMENT-only-confirmed
        -- deposit — one whose payout↔deposit tie is settled (Plane 1) but which
        -- carries NO coarse gift of its own. When the deposit already booked its
        -- own coarse gift, that gift is the single counted record for this money
        -- (design §4.3 "one count across the settlement boundary": with no
        -- per-charge counted units the coarse deposit gift stays the counted
        -- record). Expanding such a deposit into per-charge cards would surface it
        -- as unbooked and invite a second, double-counting gift, so it stays out
        -- of the live gift queue and shows only in the done/Matched queue.
        AND ${stagedPayments.matchedGiftId} IS NULL
        AND ${stagedPayments.createdGiftId} IS NULL
        AND ${stagedPayments.groupReconciledGiftId} IS NULL
        AND EXISTS (
          SELECT 1 FROM settlement_links sl
          JOIN stripe_staged_charges c ON c.stripe_payout_id = sl.payout_id
          WHERE sl.deposit_staged_payment_id = ${stagedPayments.id}
            AND COALESCE(c.matched_gift_id, c.created_gift_id) IS NULL
        )
      )
    )`;
  if (queue === "reconciled") return eq(stagedPayments.status, "reconciled");
  return queueWhere(queue as Queue);
}

// ─── GET /reconciliation/cards ────────────────────────────────────────────
// One card per QB staged_payments row (the required anchor). Compact summary
// with the auto-proposed donor/gift/opportunity + edge states; the full graph
// (with all candidates) loads lazily per card via the graph endpoint.
router.get(
  "/reconciliation/cards",
  asyncHandler(async (req, res) => {
    const queue =
      typeof req.query["queue"] === "string" ? req.query["queue"] : undefined;
    const search =
      typeof req.query["q"] === "string" ? req.query["q"].trim() : "";
    const entityId =
      typeof req.query["entityId"] === "string"
        ? req.query["entityId"]
        : undefined;
    const ready =
      req.query["ready"] === "true"
        ? true
        : req.query["ready"] === "false"
          ? false
          : undefined;
    // Excluded-queue reason filter. Validate against the enum so an arbitrary
    // string never reaches a pg-enum comparison (which would 500); an invalid
    // value is silently ignored.
    const reasonValues =
      stagedPaymentExclusionReasonEnum.enumValues as readonly string[];
    const rawReason = req.query["exclusionReason"];
    const exclusionReason =
      typeof rawReason === "string" && reasonValues.includes(rawReason)
        ? (rawReason as (typeof stagedPaymentExclusionReasonEnum.enumValues)[number])
        : undefined;
    const limit = clampInt(req.query["limit"], 50, 1, 500);
    const offset = clampInt(req.query["offset"], 0, 0, 1_000_000);
    // Gift-report funding-source filter (§4.5): stripe / donorbox / qb_direct.
    // qb_direct = money not routed through a known processor (checks, ACH, cash)
    // and unclassified rows. Validated against the closed set so an arbitrary
    // string never reaches a pg-enum comparison.
    const rawFundingSource = req.query["fundingSource"];
    const fundingSource =
      rawFundingSource === "stripe" ||
      rawFundingSource === "donorbox" ||
      rawFundingSource === "qb_direct"
        ? rawFundingSource
        : undefined;

    // Per-charge expansion only applies to the live work queues (default/all,
    // needs_review). The terminal queues (reconciled, excluded, done, rejected,
    // fiscally_sponsored) keep one card per QB staged payment.
    const shouldExpand =
      queue === undefined || queue === "all" || queue === "needs_review";

    const conds: SQL[] = [];
    const queueCond = reconciliationQueueWhere(queue);
    if (queueCond) conds.push(queueCond);
    if (exclusionReason && queue === "excluded")
      conds.push(eq(stagedPayments.exclusionReason, exclusionReason));
    if (entityId) {
      const ew = entityWhere(entityId);
      if (ew) conds.push(ew);
    }
    if (search.length >= 1) {
      const sw = stagedSearchWhere(search);
      if (sw) conds.push(sw);
    }
    if (ready === true) conds.push(readyExpr);
    else if (ready === false) conds.push(sql`NOT ${readyExpr}`);
    if (fundingSource === "stripe")
      conds.push(eq(stagedPayments.fundingSource, "stripe"));
    else if (fundingSource === "donorbox")
      conds.push(eq(stagedPayments.fundingSource, "donorbox"));
    else if (fundingSource === "qb_direct") {
      const fsCond = or(
        isNull(stagedPayments.fundingSource),
        notInArray(stagedPayments.fundingSource, ["stripe", "donorbox"]),
      );
      if (fsCond) conds.push(fsCond);
    }
    // Always collapse source groups to their representative row (one card per
    // group), in both the page and the count.
    conds.push(groupRepresentativeWhere);

    // ── Per-charge expansion (LATERAL) ──────────────────────────────────────
    // For a Stripe-payout-backed QB staged payment, expand the deposit into one
    // row per backing Stripe charge so the reconciler matches at the charge →
    // CRM-gift grain (the QB payer is "Stripe"; the real donor lives on each
    // charge). The lateral correlates to the outer staged_payments row and only
    // fires when (a) this is an expansion queue and (b) the row is NOT a manual
    // source group (those stay one card). A non-Stripe row produces zero lateral
    // rows, so the LEFT JOIN preserves it once with NULL charge columns.
    //
    // Donor name + resolved-gift facts are resolved via scalar subqueries
    // correlated on the REAL stripe_staged_charges columns (matched/created gift,
    // donor FKs) — never on the subquery's own aliased output columns, which
    // would render unqualified inside a correlated subquery and bind to the wrong
    // table.
    const chargeSub = db
      .select({
        // Both source tables expose an "id" column; aliasing each subquery
        // output to a distinct name avoids a "column reference id is ambiguous"
        // error when the outer query references charge_unit.* (drizzle would
        // otherwise emit two output columns both literally named "id").
        chargeId: sql<string>`"stripe_staged_charges"."id"`.as("charge_id"),
        payoutId: sql<string>`"stripe_payouts"."id"`.as("charge_payout_id"),
        grossAmount:
          sql<string | null>`${stripeStagedCharges.grossAmount}::text`.as(
            "charge_gross",
          ),
        netAmount:
          sql<string | null>`${stripeStagedCharges.netAmount}::text`.as(
            "charge_net",
          ),
        feeAmount:
          sql<string | null>`${stripeStagedCharges.feeAmount}::text`.as(
            "charge_fee",
          ),
        chargeStatus: stripeStagedCharges.status,
        matchStatus: stripeStagedCharges.matchStatus,
        matchConfirmedAt: stripeStagedCharges.matchConfirmedAt,
        organizationId: stripeStagedCharges.organizationId,
        individualGiverPersonId: stripeStagedCharges.individualGiverPersonId,
        householdId: stripeStagedCharges.householdId,
        payerName: stripeStagedCharges.payerName,
        donorName: sql<string | null>`COALESCE(
          (SELECT o.name FROM organizations o WHERE o.id = ${stripeStagedCharges.organizationId}),
          (SELECT h.name FROM households h WHERE h.id = ${stripeStagedCharges.householdId}),
          (SELECT COALESCE(
                    NULLIF(TRIM(pp.full_name), ''),
                    NULLIF(TRIM(CONCAT_WS(' ', pp.first_name, pp.last_name)), '')
                  )
             FROM people pp WHERE pp.id = ${stripeStagedCharges.individualGiverPersonId})
        )`.as("charge_donor_name"),
        resolvedGiftId:
          sql<string | null>`COALESCE(${stripeStagedCharges.matchedGiftId}, ${stripeStagedCharges.createdGiftId})`.as(
            "charge_resolved_gift_id",
          ),
        resolvedGiftName: sql<string | null>`(
          SELECT g.name FROM gifts_and_payments g
          WHERE g.id = COALESCE(${stripeStagedCharges.matchedGiftId}, ${stripeStagedCharges.createdGiftId})
        )`.as("charge_resolved_gift_name"),
        resolvedGiftDonorName: sql<string | null>`(
          SELECT COALESCE(
            (SELECT o.name FROM organizations o WHERE o.id = g.organization_id),
            (SELECT h.name FROM households h WHERE h.id = g.household_id),
            (SELECT COALESCE(
                      NULLIF(TRIM(pp.full_name), ''),
                      NULLIF(TRIM(CONCAT_WS(' ', pp.first_name, pp.last_name)), '')
                    )
               FROM people pp WHERE pp.id = g.individual_giver_person_id)
          )
          FROM gifts_and_payments g
          WHERE g.id = COALESCE(${stripeStagedCharges.matchedGiftId}, ${stripeStagedCharges.createdGiftId})
        )`.as("charge_resolved_gift_donor_name"),
        resolvedGiftAmount: sql<string | null>`(
          SELECT g.amount::text FROM gifts_and_payments g
          WHERE g.id = COALESCE(${stripeStagedCharges.matchedGiftId}, ${stripeStagedCharges.createdGiftId})
        )`.as("charge_resolved_gift_amount"),
        resolvedGiftDate: sql<string | null>`(
          SELECT g.date_received::text FROM gifts_and_payments g
          WHERE g.id = COALESCE(${stripeStagedCharges.matchedGiftId}, ${stripeStagedCharges.createdGiftId})
        )`.as("charge_resolved_gift_date"),
        resolvedGiftFiscalYear: sql<string | null>`(
          SELECT g.grant_year FROM gifts_and_payments g
          WHERE g.id = COALESCE(${stripeStagedCharges.matchedGiftId}, ${stripeStagedCharges.createdGiftId})
        )`.as("charge_resolved_gift_fy"),
        resolvedGiftAllocations: sql<
          | {
              entityName: string | null;
              usageLabel: string | null;
              regionalRestrictionType: string;
              usageRestrictionType: string;
              timeRestrictionType: string;
            }[]
          | null
        >`(
          SELECT jsonb_agg(
            jsonb_build_object(
              'entityName', e.name,
              'usageLabel', COALESCE(NULLIF(ga.display_usage, ''), ga.intended_usage::text),
              'regionalRestrictionType', ga.regional_restriction_type::text,
              'usageRestrictionType', ga.usage_restriction_type::text,
              'timeRestrictionType', ga.time_restriction_type::text
            ) ORDER BY ga.created_at, ga.id
          )
          FROM gift_allocations ga
          LEFT JOIN entities e ON e.id = ga.entity_id
          WHERE ga.gift_id = COALESCE(${stripeStagedCharges.matchedGiftId}, ${stripeStagedCharges.createdGiftId})
        )`.as("charge_resolved_gift_allocations"),
        // Charge auto-proposal pool: mirrors autoGiftCount/autoGiftPick for the
        // QB anchor, but scoped to the charge's donor + known-net band so a
        // charge card can propose an existing gift instead of "create gift".
        autoGiftCount: sql<number>`(
          SELECT COUNT(*)::int FROM gifts_and_payments g WHERE ${unlinkedChargeGiftWhere()}
        )`.as("charge_auto_gift_count"),
        autoGiftPick: sql<{
          id: string;
          name: string | null;
          dateReceived: string | null;
        } | null>`(
          SELECT jsonb_build_object(
            'id', g.id,
            'name', g.name,
            'dateReceived', g.date_received::text
          )
          FROM gifts_and_payments g WHERE ${unlinkedChargeGiftWhere()}
          ORDER BY ABS(g.amount - ${stripeStagedCharges.grossAmount}) ASC
          LIMIT 1
        )`.as("charge_auto_gift_pick"),
      })
      .from(stripePayouts)
      .innerJoin(
        stripeStagedCharges,
        eq(stripeStagedCharges.stripePayoutId, stripePayouts.id),
      )
      .leftJoin(
        settlementLinks,
        eq(settlementLinks.payoutId, stripePayouts.id),
      )
      .where(
        sql`${shouldExpand ? sql`TRUE` : sql`FALSE`}
          AND NOT ${isQbGroupMemberSql()}
          AND ${settlementLinks.depositStagedPaymentId} = ${stagedPayments.id}`,
      )
      .as("charge_unit");

    // Only surface UNRESOLVED charges (no gift linked yet). When the lateral
    // returns no rows (non-Stripe / non-expansion / source group) chargeId is
    // NULL and the row is kept once; when ALL of a deposit's charges are resolved
    // the lateral rows are all filtered out and the deposit drops from the queue
    // ("settles when every charge is tied").
    conds.push(
      sql`(${chargeSub.chargeId} IS NULL OR ${chargeSub.resolvedGiftId} IS NULL)`,
    );

    const where = conds.length ? and(...conds) : undefined;

    const rows = await withJoins(
      db
        .select({
          ...stagedSelect,
          // Donor the LINKED gift is recorded under. Correlated on the staged
          // row's gift-link COLUMNS (matched/created/group) — NOT the resolvedGift
          // alias — to avoid a bare aliased column rendering unqualified inside a
          // correlated subquery. Distinct from proposedDonorName (the payer-side
          // donor) so the card can surface a payer-vs-gift-donor difference.
          resolvedGiftDonorName: sql<string | null>`(
            SELECT COALESCE(
              (SELECT o.name FROM organizations o WHERE o.id = g.organization_id),
              (SELECT h.name FROM households h WHERE h.id = g.household_id),
              (SELECT COALESCE(
                        NULLIF(TRIM(pp.full_name), ''),
                        NULLIF(TRIM(CONCAT_WS(' ', pp.first_name, pp.last_name)), '')
                      )
                 FROM people pp WHERE pp.id = g.individual_giver_person_id)
            )
            FROM gifts_and_payments g
            WHERE g.id = COALESCE(
              ${stagedPayments.matchedGiftId},
              ${stagedPayments.createdGiftId},
              ${stagedPayments.groupReconciledGiftId}
            )
          )`,
          finalAmountSource: resolvedGift.finalAmountSource,
          autoGiftCount: autoGiftCountExpr,
          autoGiftPick: autoGiftPickExpr,
          cardReady: readyExpr,
          stripeEvidence: stripeEvidenceExpr,
          // Grouping is now derived from unit_group_members (the retired
          // staged_payments.source_group_id column is gone). Returns the unit
          // group id (`ug_…`) for a grouped row, NULL otherwise. Non-representative
          // members are already filtered out by groupRepresentativeWhere, so a
          // returned grouped row is always its group's representative card.
          sourceGroupId: sql<string | null>`(
            SELECT ugm.group_id FROM unit_group_members ugm
            WHERE ugm.evidence_source = 'quickbooks'
              AND ugm.source_id = ${stagedPayments.id}
            LIMIT 1
          )`.as("source_group_id"),
          sourceGroupAgg: sourceGroupAggExpr,
          recOppId: recCardOpp.id,
          recOppName: recCardOpp.name,
          chargeId: chargeSub.chargeId,
          chargePayoutId: chargeSub.payoutId,
          chargeGross: chargeSub.grossAmount,
          chargeNet: chargeSub.netAmount,
          chargeFee: chargeSub.feeAmount,
          chargeStatus: chargeSub.chargeStatus,
          chargeMatchStatus: chargeSub.matchStatus,
          chargeMatchConfirmedAt: chargeSub.matchConfirmedAt,
          chargeOrganizationId: chargeSub.organizationId,
          chargeIndividualGiverPersonId: chargeSub.individualGiverPersonId,
          chargeHouseholdId: chargeSub.householdId,
          chargePayerName: chargeSub.payerName,
          chargeDonorName: chargeSub.donorName,
          chargeResolvedGiftId: chargeSub.resolvedGiftId,
          chargeResolvedGiftName: chargeSub.resolvedGiftName,
          chargeResolvedGiftDonorName: chargeSub.resolvedGiftDonorName,
          chargeResolvedGiftAmount: chargeSub.resolvedGiftAmount,
          chargeResolvedGiftDate: chargeSub.resolvedGiftDate,
          chargeResolvedGiftFiscalYear: chargeSub.resolvedGiftFiscalYear,
          chargeResolvedGiftAllocations: chargeSub.resolvedGiftAllocations,
          chargeAutoGiftCount: chargeSub.autoGiftCount,
          chargeAutoGiftPick: chargeSub.autoGiftPick,
        })
        .from(stagedPayments)
        .$dynamic(),
    )
      .leftJoin(
        recCardOpp,
        eq(recCardOpp.id, resolvedGift.opportunityId),
      )
      .leftJoinLateral(chargeSub, sql`true`)
      .where(where)
      .orderBy(...stagedOrderBy("date_desc"), asc(chargeSub.chargeId))
      .limit(limit)
      .offset(offset);

    const totalRow = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(stagedPayments)
      .leftJoinLateral(chargeSub, sql`true`)
      .where(where);
    const total = totalRow[0]?.count ?? 0;

    const data = rows.map((row) => {
      // A per-charge card: the lateral expanded this Stripe-backed deposit into
      // one row per backing charge. Its identity is the composite
      // (stagedPaymentId, stripeChargeId); donor/gift/amount/lanes come from the
      // charge, NOT the QB deposit header (whose payer is "Stripe").
      const isCharge = row.chargeId != null;
      // A returned row carrying a sourceGroupId (its unit group id) is, by the
      // representative filter, the group's anchor — this card stands in for the
      // whole group. A charge card is never a group (the lateral requires the row
      // is not a unit_group member).
      const isSourceGroup = !isCharge && row.sourceGroupId != null;
      const groupAgg = isSourceGroup ? row.sourceGroupAgg : null;
      const donorId = isCharge
        ? (row.chargeOrganizationId ??
          row.chargeIndividualGiverPersonId ??
          row.chargeHouseholdId ??
          null)
        : (row.organizationId ??
          row.individualGiverPersonId ??
          row.householdId ??
          null);
      const donorKind = isCharge
        ? row.chargeOrganizationId
          ? "organization"
          : row.chargeIndividualGiverPersonId
            ? "person"
            : row.chargeHouseholdId
              ? "household"
              : null
        : row.organizationId
          ? "organization"
          : row.individualGiverPersonId
            ? "person"
            : row.householdId
              ? "household"
              : null;
      const donorName = isCharge
        ? (row.chargeDonorName ?? null)
        : (row.organizationName ??
          row.individualGiverPersonName ??
          row.householdName ??
          null);
      const matchStatus = isCharge ? row.chargeMatchStatus : row.matchStatus;
      const donorState =
        donorId == null
          ? "none"
          : matchStatus === "matched"
            ? "determined"
            : "ambiguous";

      // Resolved gift + per-charge gift facts (a charge card resolves its OWN
      // matched/created gift; auto-gift hints apply only to non-charge,
      // non-group rows).
      const resolvedGiftId = isCharge
        ? (row.chargeResolvedGiftId ?? null)
        : (row.resolvedGiftId ?? null);

      let giftState: string;
      let proposedGiftId: string | null = null;
      let proposedGiftName: string | null = null;
      // The received date of the linked/proposed gift. For a genuinely linked
      // gift it comes from the resolvedGift join (date_received); for an
      // auto-proposed gift the resolvedGift join is null (no matched/created/
      // group link yet) so it comes from the auto-pick payload instead.
      let proposedGiftDate: string | null = null;
      if (resolvedGiftId) {
        giftState = "determined";
        proposedGiftId = resolvedGiftId;
        proposedGiftName = isCharge
          ? (row.chargeResolvedGiftName ?? null)
          : (row.resolvedGiftName ?? null);
        proposedGiftDate = isCharge
          ? (row.chargeResolvedGiftDate ?? null)
          : (row.resolvedGiftDate ?? null);
      } else if (
        isCharge &&
        row.chargeAutoGiftCount === 1 &&
        row.chargeAutoGiftPick
      ) {
        // A charge card proposes its own donor's unlinked gift inside the
        // KNOWN-NET band (gate-consistent), so a gift booked at $104.00 behind a
        // $104.42 charge matches instead of prompting a duplicate "create gift".
        giftState = "determined";
        proposedGiftId = row.chargeAutoGiftPick.id;
        proposedGiftName = row.chargeAutoGiftPick.name ?? null;
        proposedGiftDate = row.chargeAutoGiftPick.dateReceived ?? null;
      } else if (
        !isCharge &&
        !isSourceGroup &&
        row.autoGiftCount === 1 &&
        row.autoGiftPick
      ) {
        // Auto gift proposals are matched on a SINGLE row's amount, so they are
        // meaningless for a group (whose gift must net the combined total) —
        // suppress them; the human mints/links the group's gift explicitly.
        giftState = "determined";
        proposedGiftId = row.autoGiftPick.id;
        proposedGiftName = row.autoGiftPick.name ?? null;
        proposedGiftDate = row.autoGiftPick.dateReceived ?? null;
      } else if (isCharge && (row.chargeAutoGiftCount ?? 0) > 1) {
        giftState = "ambiguous";
      } else if (!isSourceGroup && (row.autoGiftCount ?? 0) > 1) {
        giftState = "ambiguous";
      } else {
        giftState = "none";
      }

      const opportunityState = row.recOppId ? "determined" : "none";

      // For a charge card the lane status follows the CHARGE's lifecycle, not
      // the QB deposit header (which may sit at 'approved' for the whole lump).
      const laneStatus = isCharge ? (row.chargeStatus ?? row.status) : row.status;
      const donorConfirmed = isCharge
        ? row.chargeMatchConfirmedAt != null
        : row.matchConfirmedAt != null;

      return {
        stagedPaymentId: row.id,
        stripeChargeId: isCharge ? row.chargeId : null,
        status: row.status,
        queue: row.queue,
        // A charge card reconciles for the charge's own gross, not the QB lump.
        amount: isCharge ? (row.chargeGross ?? row.amount) : row.amount,
        dateReceived: row.dateReceived,
        payerName: row.payerName,
        payerEmail: row.payerEmail,
        rawReference: row.rawReference,
        lineDescription: row.lineDescription,
        qbPaymentMethod: row.qbPaymentMethod,
        qbEntityType: row.qbEntityType,
        qbEntityId: row.qbEntityId,
        qbDocNumber: row.qbDocNumber ?? null,
        qbAccountNames: row.lineAccountNames ?? null,
        qbClasses: row.lineClasses ?? null,
        qbItemNames: row.lineItemNames ?? null,
        qbTransactionMemo: row.qbTransactionMemo ?? null,
        qbLocation: row.qbLocation ?? null,
        entityId: row.entityId,
        entityName: row.entityName,
        proposedDonorId: donorId,
        proposedDonorName: donorName,
        proposedDonorKind: donorKind,
        proposedGiftId,
        proposedGiftName,
        proposedOpportunityId: row.recOppId ?? null,
        proposedOpportunityName: row.recOppName ?? null,
        donorState,
        giftState,
        opportunityState,
        // A charge card always has Stripe evidence (it IS a charge); its Stripe
        // facts come from the charge row, not the payout-level rollup.
        hasStripeEvidence: isCharge ? true : row.stripeEvidence != null,
        stripePayoutId: isCharge
          ? (row.chargePayoutId ?? null)
          : (row.stripeEvidence?.payoutId ?? null),
        stripeChargeCount: row.stripeEvidence?.chargeCount ?? null,
        stripeReconciliationStatus:
          row.stripeEvidence?.reconciliationStatus ?? null,
        // The real donor — never the "Stripe" QB payer. For a charge card fall
        // back to the charge's own payer name when no CRM donor is set yet.
        stripeChargeDonorName: isCharge
          ? (row.chargeDonorName ?? row.chargePayerName ?? null)
          : (row.stripeEvidence?.charge?.payerName ?? null),
        stripeGrossAmount: isCharge
          ? (row.chargeGross ?? null)
          : (row.stripeEvidence?.charge?.grossAmount ?? null),
        stripeNetAmount: isCharge
          ? (row.chargeNet ?? null)
          : (row.stripeEvidence?.charge?.netAmount ?? null),
        stripeFeeAmount: isCharge
          ? (row.chargeFee ?? null)
          : (row.stripeEvidence?.charge?.feeAmount ?? null),
        resolvedGiftId: isCharge
          ? (row.chargeResolvedGiftId ?? null)
          : (row.resolvedGiftId ?? null),
        resolvedGiftName: isCharge
          ? (row.chargeResolvedGiftName ?? null)
          : (row.resolvedGiftName ?? null),
        resolvedGiftDonorName: isCharge
          ? (row.chargeResolvedGiftDonorName ?? null)
          : (row.resolvedGiftDonorName ?? null),
        resolvedGiftAmount: isCharge
          ? (row.chargeResolvedGiftAmount ?? null)
          : (row.resolvedGiftAmount ?? null),
        resolvedGiftDate: proposedGiftDate,
        resolvedGiftFiscalYear: isCharge
          ? (row.chargeResolvedGiftFiscalYear ?? null)
          : (row.resolvedGiftFiscalYear ?? null),
        resolvedGiftAllocations: isCharge
          ? (row.chargeResolvedGiftAllocations ?? null)
          : (row.resolvedGiftAllocations ?? null),
        finalAmountSource: row.finalAmountSource ?? null,
        fundingSource: isSourceGroup
          ? (groupAgg?.commonFundingSource ?? null)
          : (row.fundingSource ?? null),
        fundingSourceProvenance: isSourceGroup
          ? (groupAgg?.commonProvenance ?? null)
          : (row.fundingSourceProvenance ?? null),
        // A charge card is a single charge, never a source group.
        sourceGroupId: isCharge ? null : (row.sourceGroupId ?? null),
        isSourceGroup,
        sourceGroupCount: groupAgg?.count ?? null,
        sourceGroupTotalAmount: groupAgg?.totalAmount ?? null,
        sourceGroupMembers: groupAgg
          ? groupAgg.members.map((m) => ({
              stagedPaymentId: m.stagedPaymentId,
              amount: m.amount ?? null,
              dateReceived: m.dateReceived ?? null,
              payerName: m.payerName ?? null,
              qbDocNumber: m.qbDocNumber ?? null,
              fundingSource: m.fundingSource ?? null,
              isRepresentative: m.stagedPaymentId === row.id,
            }))
          : null,
        // Revenue-accounting / QuickBooks coding snapshot (Task #449) — lives on
        // the staged payment now; surfaced read-only here so the workbench can
        // show + edit it inline without a second fetch.
        objectCode: row.objectCode ?? null,
        objectCodeOverride: row.objectCodeOverride ?? null,
        revenueLocation: row.revenueLocation ?? null,
        revenueLocationOverride: row.revenueLocationOverride ?? null,
        revenueClass: row.revenueClass ?? null,
        revenueClassOverride: row.revenueClassOverride ?? null,
        codingFlags: row.codingFlags ?? null,
        deferredRevenue: row.deferredRevenue ?? null,
        deferredRevenueReason: row.deferredRevenueReason ?? null,
        // A group card's readiness can't come from the single-row auto hint, and
        // a charge card is approved through the per-charge Stripe flow (resolve →
        // create-gift), not the one-click QB anchor approve.
        ready: !isCharge && !isSourceGroup && row.cardReady === true,
        exclusionReason: row.exclusionReason ?? null,
        reconciliationLanes: deriveEvidenceLanes({
          status: laneStatus,
          donorPresent: donorId != null,
          donorConfirmed,
          giftLinked: resolvedGiftId != null,
          giftProposed: giftState !== "none",
        }),
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : (row.createdAt ?? null),
        updatedAt:
          row.updatedAt instanceof Date
            ? row.updatedAt.toISOString()
            : (row.updatedAt ?? null),
      };
    });

    const page = Math.floor(offset / limit) + 1;
    res.json({ data, pagination: { page, limit, total } });
  }),
);

// ─── GET /reconciliation/cards/:stagedPaymentId/graph ─────────────────────
// Full proposed 4-node match graph for one card (read-only; no mutation).
router.get(
  "/reconciliation/cards/:stagedPaymentId/graph",
  asyncHandler(async (req, res) => {
    const rawId = req.params["stagedPaymentId"];
    const id = typeof rawId === "string" ? rawId : "";
    const graph = await buildReconciliationGraph(id, getViewer(req));
    if (!graph) return notFound(res, "reconciliation card");
    res.json(graph);
  }),
);

export default router;
