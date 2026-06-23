import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { stagedPayments } from "@workspace/db/schema";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { opportunitiesAndPledges } from "@workspace/db/schema";
import { qbLedgerExistsForGiftExcludingPayment } from "../../lib/paymentApplications";
import { asyncHandler, notFound } from "../../lib/helpers";
import { getViewer } from "../../lib/identityVisibility";
import { buildReconciliationGraph } from "../../lib/reconciliationGraph";
import { deriveEvidenceLanes } from "../../lib/reconciliationLanes";
import {
  entityWhere,
  isFiscallySponsoredRow,
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

// Unlinked, fee-band, same-donor gifts for the staged row's SAVED donor — the
// auto-proposal pool for the card's gift node. "Unlinked" = not matched/created
// by another staged payment and not used in another row's split. Mirrors the
// legacy giftAlreadyLinkedElsewhere logic so the card and the queue agree.
function unlinkedDonorGiftWhere(): SQL {
  return sql`(
    (${stagedPayments.organizationId} IS NOT NULL AND g.organization_id = ${stagedPayments.organizationId})
    OR (${stagedPayments.individualGiverPersonId} IS NOT NULL AND g.individual_giver_person_id = ${stagedPayments.individualGiverPersonId})
    OR (${stagedPayments.householdId} IS NOT NULL AND g.household_id = ${stagedPayments.householdId})
  )
  AND ${stagedPayments.amount} IS NOT NULL
  AND g.amount >= ${stagedPayments.amount}::numeric - 0.01
  AND g.amount <= ${stagedPayments.amount}::numeric * 1.10 + 1
  AND g.archived_at IS NULL
  AND NOT ${qbLedgerExistsForGiftExcludingPayment(
    sql.raw("g.id"),
    sql.raw('"staged_payments"."id"'),
  )}`;
}

const autoGiftCountExpr = sql<number>`(
  SELECT COUNT(*)::int FROM gifts_and_payments g WHERE ${unlinkedDonorGiftWhere()}
)`;

const autoGiftPickExpr = sql<{ id: string; name: string | null } | null>`(
  SELECT jsonb_build_object('id', g.id, 'name', g.name)
  FROM gifts_and_payments g WHERE ${unlinkedDonorGiftWhere()}
  ORDER BY ABS(g.amount - ${stagedPayments.amount}::numeric) ASC
  LIMIT 1
)`;

// A row is auto-ready when it is pending, its donor is a confirmed single match,
// and exactly one unlinked fee-band gift exists to tie it to. (The full
// consistency gate runs server-side at approve; this is the cheap list hint.)
const readyExpr = sql<boolean>`(
  ${stagedPayments.status} = 'pending'
  AND ${stagedPayments.matchStatus} = 'matched'
  AND num_nonnulls(${stagedPayments.organizationId}, ${stagedPayments.individualGiverPersonId}, ${stagedPayments.householdId}) = 1
  AND (SELECT COUNT(*)::int FROM gifts_and_payments g WHERE ${unlinkedDonorGiftWhere()}) = 1
)`;

const stripeEvidenceExpr = sql<{
  payoutId: string;
  chargeCount: number;
  reconciliationStatus: string | null;
} | null>`(
  SELECT jsonb_build_object(
    'payoutId', p.id,
    'chargeCount', (
      SELECT COUNT(*)::int FROM stripe_staged_charges c WHERE c.stripe_payout_id = p.id
    ),
    'reconciliationStatus', p.qb_reconciliation_status
  )
  FROM stripe_payouts p
  WHERE p.matched_qb_staged_payment_id = ${stagedPayments.id}
     OR p.proposed_qb_staged_payment_id = ${stagedPayments.id}
  LIMIT 1
)`;

// Collapse a manual "same physical gift" source group into ONE card: only the
// group's representative row (the min id among members, compared byte-wise via
// COLLATE "C" so it matches the approve route's JS code-unit sort) is returned;
// ungrouped rows (sourceGroupId IS NULL) always pass. Applied to BOTH the page
// query and the count so the pagination total is per-group.
const groupRepresentativeWhere: SQL = sql`(
  ${stagedPayments.sourceGroupId} IS NULL
  OR ${stagedPayments.id} = (
    SELECT MIN(grp.id COLLATE "C")
    FROM staged_payments grp
    WHERE grp.source_group_id = ${stagedPayments.sourceGroupId}
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
    WHEN ${stagedPayments.sourceGroupId} IS NULL THEN NULL
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
      WHERE m.source_group_id = ${stagedPayments.sourceGroupId}
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
// otherwise (no gift, or Stripe pending) it stays as real work. "reconciled"
// surfaces the terminal rows; any other named bucket reuses the legacy mapping
// (which includes the fiscally_sponsored parking queue itself).
function reconciliationQueueWhere(queue: string | undefined): SQL | undefined {
  if (!queue || queue === "all")
    return sql`(
      (
        ${stagedPayments.status} = 'pending'
        AND (${stagedPayments.entityId} IS NULL OR NOT (${isFiscallySponsoredRow}))
      )
      OR (
        ${stagedPayments.status} = 'approved'
        AND NOT (
          (${stagedPayments.matchedGiftId} IS NOT NULL OR ${stagedPayments.createdGiftId} IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM stripe_payouts po
            WHERE po.matched_qb_staged_payment_id = ${stagedPayments.id}
               OR po.proposed_qb_staged_payment_id = ${stagedPayments.id}
          )
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
    const limit = clampInt(req.query["limit"], 50, 1, 200);
    const offset = clampInt(req.query["offset"], 0, 0, 1_000_000);

    const conds: SQL[] = [];
    const queueCond = reconciliationQueueWhere(queue);
    if (queueCond) conds.push(queueCond);
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
    // Always collapse source groups to their representative row (one card per
    // group), in both the page and the count.
    conds.push(groupRepresentativeWhere);
    const where = conds.length ? and(...conds) : undefined;

    const rows = await withJoins(
      db
        .select({
          ...stagedSelect,
          finalAmountSource: resolvedGift.finalAmountSource,
          autoGiftCount: autoGiftCountExpr,
          autoGiftPick: autoGiftPickExpr,
          cardReady: readyExpr,
          stripeEvidence: stripeEvidenceExpr,
          sourceGroupAgg: sourceGroupAggExpr,
          recOppId: recCardOpp.id,
          recOppName: recCardOpp.name,
        })
        .from(stagedPayments)
        .$dynamic(),
    )
      .leftJoin(
        recCardOpp,
        eq(recCardOpp.id, resolvedGift.opportunityId),
      )
      .where(where)
      .orderBy(...stagedOrderBy("date_desc"))
      .limit(limit)
      .offset(offset);

    const totalRow = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(stagedPayments)
      .where(where);
    const total = totalRow[0]?.count ?? 0;

    const data = rows.map((row) => {
      // A returned row carrying a sourceGroupId is, by the representative filter,
      // the group's anchor — this card stands in for the whole group.
      const isSourceGroup = row.sourceGroupId != null;
      const groupAgg = isSourceGroup ? row.sourceGroupAgg : null;
      const donorId =
        row.organizationId ??
        row.individualGiverPersonId ??
        row.householdId ??
        null;
      const donorKind = row.organizationId
        ? "organization"
        : row.individualGiverPersonId
          ? "person"
          : row.householdId
            ? "household"
            : null;
      const donorName =
        row.organizationName ??
        row.individualGiverPersonName ??
        row.householdName ??
        null;
      const donorState =
        donorId == null
          ? "none"
          : row.matchStatus === "matched"
            ? "determined"
            : "ambiguous";

      let giftState: string;
      let proposedGiftId: string | null = null;
      let proposedGiftName: string | null = null;
      if (row.resolvedGiftId) {
        giftState = "determined";
        proposedGiftId = row.resolvedGiftId;
        proposedGiftName = row.resolvedGiftName ?? null;
      } else if (!isSourceGroup && row.autoGiftCount === 1 && row.autoGiftPick) {
        // Auto gift proposals are matched on a SINGLE row's amount, so they are
        // meaningless for a group (whose gift must net the combined total) —
        // suppress them; the human mints/links the group's gift explicitly.
        giftState = "determined";
        proposedGiftId = row.autoGiftPick.id;
        proposedGiftName = row.autoGiftPick.name ?? null;
      } else if (!isSourceGroup && (row.autoGiftCount ?? 0) > 1) {
        giftState = "ambiguous";
      } else {
        giftState = "none";
      }

      const opportunityState = row.recOppId ? "determined" : "none";

      return {
        stagedPaymentId: row.id,
        status: row.status,
        queue: row.queue,
        amount: row.amount,
        dateReceived: row.dateReceived,
        payerName: row.payerName,
        payerEmail: row.payerEmail,
        rawReference: row.rawReference,
        lineDescription: row.lineDescription,
        qbPaymentMethod: row.qbPaymentMethod,
        qbEntityType: row.qbEntityType,
        qbEntityId: row.qbEntityId,
        qbDocNumber: row.qbDocNumber ?? null,
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
        hasStripeEvidence: row.stripeEvidence != null,
        stripePayoutId: row.stripeEvidence?.payoutId ?? null,
        stripeChargeCount: row.stripeEvidence?.chargeCount ?? null,
        stripeReconciliationStatus:
          row.stripeEvidence?.reconciliationStatus ?? null,
        resolvedGiftId: row.resolvedGiftId ?? null,
        resolvedGiftName: row.resolvedGiftName ?? null,
        resolvedGiftAmount: row.resolvedGiftAmount ?? null,
        finalAmountSource: row.finalAmountSource ?? null,
        fundingSource: isSourceGroup
          ? (groupAgg?.commonFundingSource ?? null)
          : (row.fundingSource ?? null),
        fundingSourceProvenance: isSourceGroup
          ? (groupAgg?.commonProvenance ?? null)
          : (row.fundingSourceProvenance ?? null),
        sourceGroupId: row.sourceGroupId ?? null,
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
        // A group card's readiness can't come from the single-row auto hint.
        ready: !isSourceGroup && row.cardReady === true,
        reconciliationLanes: deriveEvidenceLanes({
          status: row.status,
          donorPresent: donorId != null,
          donorConfirmed: row.matchConfirmedAt != null,
          giftLinked: row.resolvedGiftId != null,
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
