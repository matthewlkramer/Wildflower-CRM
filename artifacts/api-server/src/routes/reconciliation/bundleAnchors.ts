import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { asyncHandler, parsePagination } from "../../lib/helpers";

/**
 * Unified settlement-anchor enumeration for the reactive bundle workbench.
 *
 *   GET /reconciliation/bundle-anchors
 *
 * Returns BOTH anchor kinds in one deduped, paginated list so reconciliation can
 * start from ANY anchor point:
 *   • Stripe payouts          — the per-charge GROSS source of truth.
 *   • Standalone QB deposits   — a staged_payments row with NO tied Stripe payout
 *                                (checks, ACH, wires, direct gifts).
 *
 * Money-safety (no double-book): a QB deposit that IS tied to a Stripe payout is
 * OMITTED — it reconciles THROUGH the payout's bundle (assemble canonicalizes a
 * tied QB id to its payout). Rows already grouped (source_group_id) stay in the
 * group-reconcile flow and are omitted. Rejected/excluded QB rows are not anchors
 * (this also drops processor_payout exclusions). Read-only.
 */
const router: IRouter = Router();

type AnchorQueue = "needs_review" | "confirmed" | "all";
const ANCHOR_QUEUES = ["needs_review", "confirmed", "all"] as const;
type AnchorSource = "stripe_payout" | "qb_staged_payment";

// Stripe payout buckets (over qb_reconciliation_status). `all` = every payout is
// a valid anchor (even a stray unmatched one — its charges can still mint gifts).
function stripeWhere(queue: AnchorQueue): SQL {
  switch (queue) {
    case "confirmed":
      return sql`sp.qb_reconciliation_status IN ('confirmed_reconciled','confirmed_excluded','confirmed_keep','confirmed_replace')`;
    case "needs_review":
      return sql`sp.qb_reconciliation_status IN ('unmatched','proposed','conflict_approved')`;
    case "all":
      return sql`TRUE`;
  }
}

// Standalone QB anchors: eligible (not grouped, not tied to a payout, an active
// status) AND in the requested bucket.
function qbWhere(queue: AnchorQueue): SQL {
  const eligible = sql`s.source_group_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM stripe_payouts p
      WHERE p.matched_qb_staged_payment_id = s.id
         OR p.proposed_qb_staged_payment_id = s.id
         OR p.qb_conflict_staged_payment_id = s.id
    )`;
  const statusClause =
    queue === "confirmed"
      ? sql`s.status IN ('approved','reconciled')`
      : queue === "needs_review"
        ? sql`s.status = 'pending'`
        : sql`s.status IN ('pending','approved','reconciled')`;
  return sql`${eligible} AND ${statusClause}`;
}

interface AnchorRow {
  anchor_type: AnchorSource;
  anchor_id: string;
  amount: string | null;
  anchor_date: string | null;
  payer_name: string | null;
  charge_count: number | null;
  status_label: string;
}

// ─── GET /reconciliation/bundle-anchors ────────────────────────────────────
router.get(
  "/reconciliation/bundle-anchors",
  asyncHandler(async (req, res) => {
    const rawQueue =
      typeof req.query["queue"] === "string" ? req.query["queue"] : "";
    const queue: AnchorQueue = (ANCHOR_QUEUES as readonly string[]).includes(
      rawQueue,
    )
      ? (rawQueue as AnchorQueue)
      : "needs_review";
    const rawSource =
      typeof req.query["source"] === "string" ? req.query["source"] : "";
    const source: AnchorSource | null =
      rawSource === "stripe_payout" || rawSource === "qb_staged_payment"
        ? rawSource
        : null;
    const { limit, offset, page } = parsePagination(req.query);

    // Normalized projection over each source — identical column list/types so the
    // two halves UNION ALL cleanly. The active deposit (matched, else the
    // proposed/conflicting candidate) supplies the payer name for a Stripe payout.
    const stripeSelect = sql`
      SELECT
        'stripe_payout'::text AS anchor_type,
        sp.id AS anchor_id,
        COALESCE(sp.net_total, sp.amount)::text AS amount,
        sp.arrival_date::text AS anchor_date,
        ad.payer_name AS payer_name,
        sp.charge_count AS charge_count,
        sp.qb_reconciliation_status::text AS status_label
      FROM stripe_payouts sp
      LEFT JOIN staged_payments ad
        ON ad.id = COALESCE(
          sp.matched_qb_staged_payment_id,
          sp.proposed_qb_staged_payment_id,
          sp.qb_conflict_staged_payment_id
        )
      WHERE ${stripeWhere(queue)}`;

    const qbSelect = sql`
      SELECT
        'qb_staged_payment'::text AS anchor_type,
        s.id AS anchor_id,
        s.amount::text AS amount,
        s.date_received::text AS anchor_date,
        s.payer_name AS payer_name,
        NULL::int AS charge_count,
        s.status::text AS status_label
      FROM staged_payments s
      WHERE ${qbWhere(queue)}`;

    const merged: SQL =
      source === "stripe_payout"
        ? stripeSelect
        : source === "qb_staged_payment"
          ? qbSelect
          : sql`${stripeSelect} UNION ALL ${qbSelect}`;

    const [dataResult, totalResult] = await Promise.all([
      db.execute(sql`
        SELECT
          anchor_type, anchor_id, amount, anchor_date,
          payer_name, charge_count, status_label
        FROM ( ${merged} ) AS anchors
        ORDER BY anchor_date DESC NULLS LAST, anchor_id DESC
        LIMIT ${limit} OFFSET ${offset}
      `),
      db.execute(sql`SELECT count(*)::int AS total FROM ( ${merged} ) AS anchors`),
    ]);

    const rows = dataResult.rows as unknown as AnchorRow[];
    const total = Number((totalResult.rows[0] as { total: number } | undefined)?.total ?? 0);

    res.json({
      data: rows.map((r) => ({
        anchorType: r.anchor_type,
        anchorId: r.anchor_id,
        amount: r.amount,
        date: r.anchor_date,
        payerName: r.payer_name,
        chargeCount: r.charge_count,
        statusLabel: r.status_label,
      })),
      pagination: { page, limit, total },
    });
  }),
);

export default router;
