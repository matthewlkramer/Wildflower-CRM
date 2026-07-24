import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { asyncHandler, parsePagination } from "../../lib/helpers";
import {
  chargeStatusCaseText,
  qbStatusCaseText,
} from "../../lib/derivedStatus";

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
 * tied QB id to its payout). Rejected/excluded QB rows are not anchors
 * (this also drops processor_payout exclusions). Read-only.
 */
const router: IRouter = Router();

type AnchorQueue = "needs_review" | "confirmed" | "all";
const ANCHOR_QUEUES = ["needs_review", "confirmed", "all"] as const;
type AnchorSource = "stripe_payout" | "qb_staged_payment";

// Stripe payout buckets (over the settled_stripe_payout_id pairing fact on the
// QBO row). `all` = every payout is a valid anchor (even a stray orphan one —
// its charges can still mint gifts).
//
// A payout only NEEDS review when there is actionable work in this workbench:
// it has NO settled QBO lump AND at least one of its charges has not yet been
// reconciled/excluded/rejected (or a proposed charge-grain QB tie is awaiting
// approval). An orphan payout whose charges are ALL settled has nothing to do
// here — there is no QB deposit to tie — so it must NOT linger in needs_review.
// FULLY CHARGE-TIED = the settlement path for "individually-booked" payouts:
// no deposit lump exists (the bookkeeper recorded one QB row per donation),
// but every charge is either confirmed-tied to its own QB row (a confirmed
// source_links charge_qb_tie row; SQL aliases keep the legacy
// `linked_qb_staged_payment_id` name for API compatibility) or terminal. Such
// a payout is SETTLED — it shows as Matched, not Missing deposit.
const payoutSettled = sql`EXISTS (
  SELECT 1 FROM staged_payments slp WHERE slp.settled_stripe_payout_id = sp.id
)`;
export const fullyChargeTied = sql`(
  NOT ${payoutSettled}
  AND EXISTS (
    SELECT 1 FROM stripe_staged_charges c
    WHERE c.stripe_payout_id = sp.id
      AND EXISTS (
        SELECT 1 FROM source_links srcl_ct
        WHERE srcl_ct.link_type = 'charge_qb_tie'
          AND srcl_ct.lifecycle = 'confirmed'
          AND srcl_ct.stripe_charge_id = c.id
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM stripe_staged_charges c
    WHERE c.stripe_payout_id = sp.id
      AND NOT EXISTS (
        SELECT 1 FROM source_links srcl_ct
        WHERE srcl_ct.link_type = 'charge_qb_tie'
          AND srcl_ct.lifecycle = 'confirmed'
          AND srcl_ct.stripe_charge_id = c.id
      )
      AND c.exclusion_reason IS NULL
  )
)`;

function stripeWhere(queue: AnchorQueue): SQL {
  switch (queue) {
    case "confirmed":
      return sql`(${payoutSettled} OR ${fullyChargeTied})`;
    case "needs_review":
      return sql`(
        NOT ${payoutSettled}
        AND (
          EXISTS (
            SELECT 1 FROM stripe_staged_charges c
            WHERE c.stripe_payout_id = sp.id
              AND c.exclusion_reason IS NULL
              -- pending = no counted ledger row (pointer columns retired)
              AND NOT EXISTS (
                SELECT 1 FROM payment_applications pa
                WHERE pa.stripe_charge_id = c.id
                  AND pa.evidence_source = 'stripe' AND pa.link_role = 'counted'
              )
          )
          -- A proposed charge-grain QB tie is actionable work here even when
          -- every charge is already gift-booked (reconciled): the human still
          -- needs to approve the settlement ties.
          OR EXISTS (
            SELECT 1 FROM stripe_staged_charges c
            WHERE c.stripe_payout_id = sp.id
              AND EXISTS (
                SELECT 1 FROM source_links srcl_pt
                WHERE srcl_pt.link_type = 'charge_qb_tie'
                  AND srcl_pt.lifecycle = 'proposed'
                  AND srcl_pt.stripe_charge_id = c.id
              )
          )
        )
      ) AND NOT ${fullyChargeTied}`;
    case "all":
      return sql`TRUE`;
  }
}

// Standalone QB anchors: eligible (not tied to a payout via a settlement
// link, an active status) AND in the requested bucket.
//
// A standalone QB deposit is only worth surfacing as a "may still need a Stripe
// payout tie" anchor when its origin is plausibly Stripe. Most deposits never
// come from Stripe (checks, ACH/wires, brokerage/stock, DAFs, PayPal, employer
// matches, …); framing those as "Missing payout" buries the genuine gaps. So we
// drop rows whose `funding_source` carries a clear NON-Stripe signal, keeping
// only `stripe`, `donorbox` (Donorbox frequently settles through Stripe), and
// NULL (unknown — no signal either way, so never hide it).
function qbWhere(queue: AnchorQueue): SQL {
  const eligible = sql`s.settled_stripe_payout_id IS NULL
    AND NOT EXISTS (
      -- A QB row confirmed-tied to a Stripe charge reconciles THROUGH that
      -- charge's payout (charge-grain twin of the settlement-link omission
      -- above) — it no longer "needs a payout tie".
      SELECT 1 FROM source_links srcl_qt
      WHERE srcl_qt.link_type = 'charge_qb_tie'
        AND srcl_qt.lifecycle = 'confirmed'
        AND srcl_qt.qb_staged_payment_id = s.id
    )`;
  const plausiblyStripe = sql`(
      s.funding_source IS NULL
      OR s.funding_source NOT IN (
        'brokerage','daf','paypal','wire_ach','check','cash','employer_match','other'
      )
    )`;
  // Counted-ledger rows are the SOLE gift-link source (the legacy staged
  // gift-link columns are @deprecated and no longer written).
  const resolvedEvidence = `EXISTS (
      SELECT 1 FROM payment_applications pa
      WHERE pa.payment_id = s.id AND pa.link_role = 'counted'
    )`;
  const statusClause =
    queue === "confirmed"
      ? sql`(s.exclusion_reason IS NULL AND ${sql.raw(resolvedEvidence)})`
      : queue === "needs_review"
        ? sql`(s.exclusion_reason IS NULL AND NOT ${sql.raw(resolvedEvidence)})`
        : sql`s.exclusion_reason IS NULL`;
  return sql`${eligible} AND ${plausiblyStripe} AND ${statusClause}`;
}

interface PayoutChargeRow {
  id: string;
  payerName: string | null;
  amount: string | null;
  fee: string | null;
  net: string | null;
  description: string | null;
  statementDescriptor: string | null;
  date: string | null;
  status: string | null;
  exclusionReason: string | null;
  linkedQbStagedPaymentId: string | null;
  linkedFeeQbStagedPaymentId: string | null;
  proposedQb: {
    id: string;
    payerName: string | null;
    amount: string | null;
    date: string | null;
    memo: string | null;
  } | null;
}

interface AnchorRow {
  anchor_type: AnchorSource;
  anchor_id: string;
  amount: string | null;
  bank_amount: string | null;
  gross_total: string | null;
  fee_total: string | null;
  anchor_date: string | null;
  payer_name: string | null;
  charge_count: number | null;
  charges: PayoutChargeRow[] | null;
  // QB-anchor-only descriptive context (null for a Stripe payout).
  line_description: string | null;
  memo: string | null;
  reference: string | null;
  line_item_names: string[] | null;
  line_account_names: string[] | null;
  line_classes: string[] | null;
  status_label: string;
  batch_status: "settled" | "orphan";
  // Charge-grain QB tie rollups (null for a QB anchor).
  charge_ties_proposed: number | null;
  charge_ties_confirmed: number | null;
  // Cached confirm-readiness from the anchor's latest bundle-draft snapshot.
  readiness_ready: boolean | null;
  readiness_warning: number | null;
  readiness_blocker: number | null;
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
    // two halves UNION ALL cleanly. The settled QBO lump supplies the payer name
    // for a Stripe payout. status_label is DERIVED from the pairing fact:
    // settled → 'confirmed_reconciled', otherwise 'unmatched'.
    // Cached confirm-readiness (a hint; confirm re-derives + re-gates) pulled from
    // the anchor's latest bundle-draft snapshot summary. `d` must be the joined
    // reconciliation_bundle_drafts alias in the surrounding SELECT.
    const readinessSelect = (d: string) => sql`
        (${sql.raw(d)}.derived_proposal->'summary'->>'ready')::boolean AS readiness_ready,
        (${sql.raw(d)}.derived_proposal->'summary'->>'warningCount')::int AS readiness_warning,
        (${sql.raw(d)}.derived_proposal->'summary'->>'blockerCount')::int AS readiness_blocker`;

    const stripeSelect = sql`
      SELECT
        'stripe_payout'::text AS anchor_type,
        sp.id AS anchor_id,
        COALESCE(sp.net_total, sp.amount)::text AS amount,
        -- The raw bank payout amount — what actually hit the bank. Differs from
        -- the charge-sum net when the payout absorbed failed-payment reversals
        -- or refunds; this is the figure that matches the QB deposit.
        sp.amount::text AS bank_amount,
        sp.gross_total::text AS gross_total,
        sp.fee_total::text AS fee_total,
        sp.arrival_date::text AS anchor_date,
        ad.payer_name AS payer_name,
        sp.charge_count AS charge_count,
        COALESCE((
          SELECT json_agg(json_build_object(
              'id', c.id,
              'payerName', COALESCE(c.payer_name, c.description),
              'amount', c.gross_amount::text,
              'fee', c.fee_amount::text,
              'net', c.net_amount::text,
              'description', c.description,
              'statementDescriptor', c.statement_descriptor,
              'date', c.date_received::text,
              'status', c.status,
              'exclusionReason', c.exclusion_reason,
              'linkedQbStagedPaymentId', c.linked_qb_staged_payment_id,
              'linkedFeeQbStagedPaymentId', c.linked_fee_qb_staged_payment_id,
              'proposedQb', CASE WHEN c.pq_id IS NOT NULL THEN json_build_object(
                  'id', c.pq_id,
                  'payerName', c.pq_payer_name,
                  'amount', c.pq_amount,
                  'date', c.pq_date,
                  'memo', c.pq_memo
                ) END
            ) ORDER BY c.gross_amount DESC NULLS LAST)
          FROM (
            SELECT cc.id, cc.payer_name, cc.description, cc.statement_descriptor,
                   cc.gross_amount, cc.fee_amount, cc.net_amount, cc.date_received,
                   ${sql.raw(chargeStatusCaseText("cc"))} AS status,
                   cc.exclusion_reason,
                   srcl_conf.qb_staged_payment_id AS linked_qb_staged_payment_id,
                   srcl_fee.qb_staged_payment_id AS linked_fee_qb_staged_payment_id,
                   pq.id AS pq_id, pq.payer_name AS pq_payer_name,
                   pq.amount::text AS pq_amount, pq.date_received::text AS pq_date,
                   COALESCE(pq.qb_transaction_memo, pq.line_description) AS pq_memo
            FROM stripe_staged_charges cc
            LEFT JOIN source_links srcl_conf
              ON srcl_conf.link_type = 'charge_qb_tie'
             AND srcl_conf.lifecycle = 'confirmed'
             AND srcl_conf.stripe_charge_id = cc.id
            LEFT JOIN source_links srcl_fee
              ON srcl_fee.link_type = 'charge_fee_row'
             AND srcl_fee.stripe_charge_id = cc.id
            LEFT JOIN source_links srcl_prop
              ON srcl_prop.link_type = 'charge_qb_tie'
             AND srcl_prop.lifecycle = 'proposed'
             AND srcl_prop.stripe_charge_id = cc.id
            LEFT JOIN staged_payments pq
              ON pq.id = srcl_prop.qb_staged_payment_id
            WHERE cc.stripe_payout_id = sp.id
            ORDER BY cc.gross_amount DESC NULLS LAST
            LIMIT 50
          ) c
        ), '[]'::json) AS charges,
        NULL::text AS line_description,
        NULL::text AS memo,
        NULL::text AS reference,
        NULL::text[] AS line_item_names,
        NULL::text[] AS line_account_names,
        NULL::text[] AS line_classes,
        (CASE WHEN ad.id IS NOT NULL THEN 'confirmed_reconciled' ELSE 'unmatched' END)::text AS status_label,
        (CASE
          WHEN ad.id IS NOT NULL THEN 'settled'
          WHEN ${fullyChargeTied} THEN 'settled'
          ELSE 'orphan'
        END)::text AS batch_status,
        (SELECT count(*)::int FROM stripe_staged_charges cc
          JOIN source_links srcl_p
            ON srcl_p.link_type = 'charge_qb_tie'
           AND srcl_p.lifecycle = 'proposed'
           AND srcl_p.stripe_charge_id = cc.id
          WHERE cc.stripe_payout_id = sp.id) AS charge_ties_proposed,
        (SELECT count(*)::int FROM stripe_staged_charges cc
          JOIN source_links srcl_c
            ON srcl_c.link_type = 'charge_qb_tie'
           AND srcl_c.lifecycle = 'confirmed'
           AND srcl_c.stripe_charge_id = cc.id
          WHERE cc.stripe_payout_id = sp.id) AS charge_ties_confirmed,
        ${readinessSelect("d")}
      FROM stripe_payouts sp
      LEFT JOIN staged_payments ad ON ad.settled_stripe_payout_id = sp.id
      LEFT JOIN reconciliation_bundle_drafts d
        ON d.anchor_type = 'stripe_payout' AND d.anchor_id = sp.id
      WHERE ${stripeWhere(queue)}`;

    const qbSelect = sql`
      SELECT
        'qb_staged_payment'::text AS anchor_type,
        s.id AS anchor_id,
        s.amount::text AS amount,
        NULL::text AS bank_amount,
        NULL::text AS gross_total,
        NULL::text AS fee_total,
        s.date_received::text AS anchor_date,
        s.payer_name AS payer_name,
        NULL::int AS charge_count,
        '[]'::json AS charges,
        s.line_description AS line_description,
        s.qb_transaction_memo AS memo,
        s.raw_reference AS reference,
        s.line_item_names AS line_item_names,
        s.line_account_names AS line_account_names,
        s.line_classes AS line_classes,
        ${sql.raw(qbStatusCaseText("s"))}::text AS status_label,
        'orphan'::text AS batch_status,
        NULL::int AS charge_ties_proposed,
        NULL::int AS charge_ties_confirmed,
        ${readinessSelect("d")}
      FROM staged_payments s
      LEFT JOIN reconciliation_bundle_drafts d
        ON d.anchor_type = 'qb_staged_payment' AND d.anchor_id = s.id
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
          anchor_type, anchor_id, amount, bank_amount, gross_total, fee_total, anchor_date,
          payer_name, charge_count, charges,
          line_description, memo, reference,
          line_item_names, line_account_names, line_classes,
          status_label, batch_status,
          charge_ties_proposed, charge_ties_confirmed,
          readiness_ready, readiness_warning, readiness_blocker
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
        bankAmount: r.bank_amount,
        grossTotal: r.gross_total,
        feeTotal: r.fee_total,
        date: r.anchor_date,
        payerName: r.payer_name,
        chargeCount: r.charge_count,
        charges: r.charges ?? [],
        lineDescription: r.line_description,
        memo: r.memo,
        reference: r.reference,
        lineItemNames: r.line_item_names,
        lineAccountNames: r.line_account_names,
        lineClasses: r.line_classes,
        statusLabel: r.status_label,
        batchStatus: r.batch_status,
        chargeTiesProposed: r.charge_ties_proposed,
        chargeTiesConfirmed: r.charge_ties_confirmed,
        readiness:
          r.readiness_ready === null
            ? null
            : {
                ready: r.readiness_ready,
                warningCount: r.readiness_warning ?? 0,
                blockerCount: r.readiness_blocker ?? 0,
              },
      })),
      pagination: { page, limit, total },
    });
  }),
);

export default router;
