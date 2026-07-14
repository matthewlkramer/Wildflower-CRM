// ─── Linked-payment summary — ledger-authoritative settled gross + fees ───────
//
// A gift's settled amount and processor fees are derived ONLY from confirmed,
// counted payment_applications rows. Legacy matched_gift_id / created_gift_id
// pointers on Stripe charges and Donorbox donations are deliberately ignored.
//
//   1. QuickBooks — amount_applied; no per-gift fee.
//   2. Stripe — amount_applied; fee joined through stripe_charge_id.
//   3. Donorbox — amount_applied; fee joined through donorbox_donation_id,
//      excluding donation_type='stripe' enrichment rows because the backing
//      Stripe charge is the counted unit.
//
// Proposed or exempt applications never enter settled gross, fee totals, or
// has-linked-payment. This keeps auto-match proposals from prematurely funding a
// gift and makes payment_applications the single unit↔gift source of truth.
//
// CRITICAL CORRELATION RULE (the bare-column footgun): the gift-id correlation
// is passed in as a literal SQL expression, never as an interpolated drizzle
// Column. See `.agents/memory/drizzle-sql-template-bare-column.md`.
import type { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Default gift-id correlation for an UN-ALIASED `.from(giftsAndPayments)`. */
export const DEFAULT_GIFT_ID_SQL: SQL = sql.raw('"gifts_and_payments"."id"');

/**
 * Shared confirmed-counted application predicate. Every monetary read must use
 * the same lifecycle rule so proposed rows never look settled.
 */
function confirmedCountedForGift(giftIdSql: SQL): SQL<boolean> {
  return sql<boolean>`(
    pa.gift_id = ${giftIdSql}
    AND pa.link_role = 'counted'
    AND pa.lifecycle = 'confirmed'
  )`;
}

/**
 * Donorbox-through-Stripe rows are enrichment only. They must never be counted
 * as a second money unit beside their backing Stripe charge.
 */
function isCountableApplication(): SQL<boolean> {
  return sql<boolean>`(
    pa.evidence_source <> 'donorbox'
    OR dd.donation_type IS DISTINCT FROM 'stripe'
  )`;
}

/**
 * Settled GROSS booked against a gift across all money sources, as a numeric
 * text value ('0' when nothing is linked).
 */
export function settledGrossForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string> {
  return sql<string>`(
    COALESCE((
      SELECT SUM(pa.amount_applied)
      FROM payment_applications pa
      LEFT JOIN donorbox_donations dd
        ON dd.id = pa.donorbox_donation_id
      WHERE ${confirmedCountedForGift(giftIdSql)}
        AND ${isCountableApplication()}
    ), 0)
  )::text`;
}

/**
 * Total processor fees booked against a gift, as numeric text ('0' when none).
 * Fees are attributes of the anchored source unit, not separate money rows.
 */
export function totalFeesForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string> {
  return sql<string>`(
    COALESCE((
      SELECT SUM(
        CASE
          WHEN pa.evidence_source = 'stripe' THEN COALESCE(ssc.fee_amount, 0)
          WHEN pa.evidence_source = 'donorbox'
            AND dd.donation_type IS DISTINCT FROM 'stripe'
            THEN COALESCE(dd.processing_fee, 0)
          ELSE 0
        END
      )
      FROM payment_applications pa
      LEFT JOIN stripe_staged_charges ssc
        ON ssc.id = pa.stripe_charge_id
      LEFT JOIN donorbox_donations dd
        ON dd.id = pa.donorbox_donation_id
      WHERE ${confirmedCountedForGift(giftIdSql)}
        AND ${isCountableApplication()}
    ), 0)
  )::text`;
}

/**
 * EXISTS any confirmed counted payment application for the gift.
 */
export function hasLinkedPaymentForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM payment_applications pa
    LEFT JOIN donorbox_donations dd
      ON dd.id = pa.donorbox_donation_id
    WHERE ${confirmedCountedForGift(giftIdSql)}
      AND ${isCountableApplication()}
  )`;
}

/**
 * Read-model projection of the settled gross: the settled amount when ANY
 * payment is linked, else NULL.
 */
export function derivedSettledAmountForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string | null> {
  return sql<string | null>`CASE WHEN ${hasLinkedPaymentForGift(giftIdSql)}
    THEN ${settledGrossForGift(giftIdSql)} ELSE NULL END`;
}

/**
 * Read-model projection of total processor fees: NULL when no fee-bearing
 * payment is linked.
 */
export function derivedProcessorFeeForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string | null> {
  return sql<string | null>`NULLIF(${totalFeesForGift(giftIdSql)}::numeric, 0)::text`;
}

/**
 * Whether a gift is OFF-BOOKS / payment-exempt, derived only from allocations.
 */
export function giftIsOffBooksExpr(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`(
    EXISTS (
      SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = ${giftIdSql}
    )
    AND NOT EXISTS (
      SELECT 1 FROM gift_allocations ga
      LEFT JOIN entities e ON e.id = ga.entity_id
      WHERE ga.gift_id = ${giftIdSql}
        AND (ga.entity_id IS NULL OR COALESCE(e.expects_payment, true) = true)
    )
  )`;
}

/** Inverse of giftIsOffBooksExpr: the gift expects a payment. */
export function giftExpectsPaymentExpr(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`(NOT ${giftIsOffBooksExpr(giftIdSql)})`;
}

export interface GiftPaymentSummary {
  /** Settled gross across all sources, as a number (0 when nothing linked). */
  settledGross: number;
  /** Total processor fees across all sources, as a number (0 when none). */
  totalFees: number;
  /** Whether any confirmed counted payment is linked to the gift. */
  hasLinkedPayment: boolean;
}

const toNum = (v: string | number | null | undefined): number => {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
};

/** Single-gift read sharing the same SQL fragments as list projections. */
export async function getGiftPaymentSummary(
  tx: Tx,
  giftId: string,
): Promise<GiftPaymentSummary> {
  const giftIdParam = sql`${giftId}`;
  const result = await tx.execute<{
    settled_gross: string | null;
    total_fees: string | null;
    has_linked_payment: boolean | null;
  }>(sql`
    SELECT
      ${settledGrossForGift(giftIdParam)} AS settled_gross,
      ${totalFeesForGift(giftIdParam)} AS total_fees,
      ${hasLinkedPaymentForGift(giftIdParam)} AS has_linked_payment
  `);
  const row = result.rows[0];
  return {
    settledGross: toNum(row?.settled_gross),
    totalFees: toNum(row?.total_fees),
    hasLinkedPayment: Boolean(row?.has_linked_payment),
  };
}
