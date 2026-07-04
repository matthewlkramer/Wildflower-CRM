import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { asyncHandler, parsePagination } from "../../lib/helpers";
import { payoutStatusLabelSql } from "../../lib/settlementLink";

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

// Stripe payout buckets (over the settlement_links mirror — S5 read-flip). `all` =
// every payout is a valid anchor (even a stray orphan one — its charges can still
// mint gifts).
//
// A payout only NEEDS review when there is actionable work in this workbench:
//   • its QB-deposit tie is awaiting a human decision (a `proposed` settlement
//     link), OR
//   • it has NO settlement link (orphan) AND at least one of its charges has not
//     yet been reconciled/excluded/rejected (i.e. a gift still needs to be
//     minted/matched).
// An orphan payout whose charges are ALL settled has nothing to do here — there is
// no QB deposit to tie — so it must NOT linger in needs_review (the per-charge
// gifts have already been confirmed). It still shows under `all`, and re-enters
// needs_review as `proposed` if the admin propose-all tie pass runs.
function stripeWhere(queue: AnchorQueue): SQL {
  switch (queue) {
    case "confirmed":
      return sql`EXISTS (
        SELECT 1 FROM settlement_links sl
        WHERE sl.payout_id = sp.id AND sl.lifecycle = 'confirmed'
      )`;
    case "needs_review":
      return sql`(
        EXISTS (
          SELECT 1 FROM settlement_links sl
          WHERE sl.payout_id = sp.id AND sl.lifecycle = 'proposed'
        )
        OR (
          NOT EXISTS (SELECT 1 FROM settlement_links sl WHERE sl.payout_id = sp.id)
          AND EXISTS (
            SELECT 1 FROM stripe_staged_charges c
            WHERE c.stripe_payout_id = sp.id
              AND c.status NOT IN ('reconciled','excluded','rejected')
          )
        )
      )`;
    case "all":
      return sql`TRUE`;
  }
}

// Standalone QB anchors: eligible (not grouped, not tied to a payout via a
// settlement link, an active status) AND in the requested bucket.
function qbWhere(queue: AnchorQueue): SQL {
  const eligible = sql`s.source_group_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM settlement_links sl
      WHERE sl.deposit_staged_payment_id = s.id
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
  batch_status: "settled" | "proposed" | "orphan";
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
    // two halves UNION ALL cleanly. The settlement link's deposit supplies the
    // payer name for a Stripe payout. status_label is now DERIVED from the joined
    // settlement link (Phase-6 read-flip) — the four live values are lossless (prod
    // holds zero legacy 7-value rows); a payout with no link → 'unmatched'.
    const stripeSelect = sql`
      SELECT
        'stripe_payout'::text AS anchor_type,
        sp.id AS anchor_id,
        COALESCE(sp.net_total, sp.amount)::text AS amount,
        sp.arrival_date::text AS anchor_date,
        ad.payer_name AS payer_name,
        sp.charge_count AS charge_count,
        ${payoutStatusLabelSql}::text AS status_label,
        (CASE
          WHEN EXISTS (SELECT 1 FROM settlement_links sl2
                       WHERE sl2.payout_id = sp.id AND sl2.lifecycle = 'confirmed')
            THEN 'settled'
          WHEN EXISTS (SELECT 1 FROM settlement_links sl2
                       WHERE sl2.payout_id = sp.id AND sl2.lifecycle = 'proposed')
            THEN 'proposed'
          ELSE 'orphan'
        END)::text AS batch_status
      FROM stripe_payouts sp
      LEFT JOIN settlement_links sl ON sl.payout_id = sp.id
      LEFT JOIN staged_payments ad ON ad.id = sl.deposit_staged_payment_id
      WHERE ${stripeWhere(queue)}`;

    const qbSelect = sql`
      SELECT
        'qb_staged_payment'::text AS anchor_type,
        s.id AS anchor_id,
        s.amount::text AS amount,
        s.date_received::text AS anchor_date,
        s.payer_name AS payer_name,
        NULL::int AS charge_count,
        s.status::text AS status_label,
        'orphan'::text AS batch_status
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
          payer_name, charge_count, status_label, batch_status
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
        batchStatus: r.batch_status,
      })),
      pagination: { page, limit, total },
    });
  }),
);

export default router;
