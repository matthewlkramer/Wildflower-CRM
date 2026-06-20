import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { stagedPayments } from "@workspace/db/schema";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { opportunitiesAndPledges } from "@workspace/db/schema";
import { asyncHandler, notFound } from "../../lib/helpers";
import { getViewer } from "../../lib/identityVisibility";
import { buildReconciliationGraph } from "../../lib/reconciliationGraph";
import {
  entityWhere,
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
  AND NOT EXISTS (
    SELECT 1 FROM staged_payments sp2
    WHERE (sp2.matched_gift_id = g.id OR sp2.created_gift_id = g.id)
      AND sp2.id <> ${stagedPayments.id}
  )
  AND NOT EXISTS (
    SELECT 1 FROM staged_payment_splits spl2
    WHERE spl2.gift_id = g.id AND spl2.staged_payment_id <> ${stagedPayments.id}
  )`;
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
} | null>`(
  SELECT jsonb_build_object('payoutId', p.id, 'chargeCount', (
    SELECT COUNT(*)::int FROM stripe_staged_charges c WHERE c.stripe_payout_id = p.id
  ))
  FROM stripe_payouts p
  WHERE p.matched_qb_staged_payment_id = ${stagedPayments.id}
     OR p.proposed_qb_staged_payment_id = ${stagedPayments.id}
  LIMIT 1
)`;

// Default reconciliation queue: the live work (pending + approved-but-not-yet-
// reconciled). "reconciled" surfaces the terminal rows; any other named bucket
// reuses the legacy queueWhere mapping.
function reconciliationQueueWhere(queue: string | undefined): SQL | undefined {
  if (!queue || queue === "all")
    return inArray(stagedPayments.status, ["pending", "approved"]);
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
    if (search.length >= 1) conds.push(stagedSearchWhere(search));
    if (ready === true) conds.push(readyExpr);
    else if (ready === false) conds.push(sql`NOT ${readyExpr}`);
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
          recOppId: recCardOpp.id,
          recOppName: recCardOpp.name,
        })
        .from(stagedPayments)
        .$dynamic(),
    )
      .leftJoin(
        recCardOpp,
        eq(recCardOpp.id, resolvedGift.paymentOnPledgeId),
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
      } else if (row.autoGiftCount === 1 && row.autoGiftPick) {
        giftState = "determined";
        proposedGiftId = row.autoGiftPick.id;
        proposedGiftName = row.autoGiftPick.name ?? null;
      } else if ((row.autoGiftCount ?? 0) > 1) {
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
        resolvedGiftId: row.resolvedGiftId ?? null,
        resolvedGiftName: row.resolvedGiftName ?? null,
        resolvedGiftAmount: row.resolvedGiftAmount ?? null,
        finalAmountSource: row.finalAmountSource ?? null,
        ready: row.cardReady === true,
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
    const id = req.params["stagedPaymentId"] ?? "";
    const graph = await buildReconciliationGraph(id, getViewer(req));
    if (!graph) return notFound(res, "reconciliation card");
    res.json(graph);
  }),
);

export default router;
