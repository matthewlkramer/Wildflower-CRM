// ─── Linked-payment summary — the ONE settled-gross + fees derivation ────────
//
// Task #448 Step 2. A gift's settled amount and processor fees are no longer
// stored on the header (the `final_amount_*` / `processor_fee` columns are
// deprecated). They are DERIVED at read time from the payments linked to the
// gift, across all three money sources:
//
//   1. QuickBooks  — payment_applications rows (evidence_source = 'quickbooks').
//      gross = SUM(amount_applied); QB carries no per-gift fee, so fee = 0.
//   2. Stripe      — stripe_staged_charges linked via matched_gift_id OR
//      created_gift_id. gross = SUM(gross_amount); fee = SUM(fee_amount).
//   3. Donorbox    — donorbox_donations linked via matched_gift_id OR
//      created_gift_id, EXCLUDING donation_type = 'stripe' (those donations are
//      already counted through their backing Stripe charge — counting them here
//      too would double-count). gross = SUM(amount); fee = SUM(processing_fee).
//
// This module is the single source the derived read-model fields AND the
// settled-vs-entered reconciliation queue both consume, so the two can never
// disagree about what "settled" means.
//
// CRITICAL CORRELATION RULE (the bare-column footgun): the gift-id correlation
// is passed in as a *literal* SQL expression, never as an interpolated drizzle
// Column. Interpolating a Column (`${giftsAndPayments.id}`) into a `sql`
// template renders the BARE, UNQUALIFIED name (`"id"`), which inside a
// correlated subquery silently binds to the INNER table's own `id` and returns
// wrong results. See `.agents/memory/drizzle-sql-template-bare-column.md`. By
// taking a pre-qualified expression we keep the correlation explicit and always
// correct. The default targets an UN-ALIASED `.from(giftsAndPayments)` query
// (drizzle qualifies columns as `"gifts_and_payments"."id"`); raw-SQL or aliased
// callers pass their own alias, e.g. `sql.raw("g.id")`.
import type { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Default gift-id correlation for an UN-ALIASED `.from(giftsAndPayments)`. */
export const DEFAULT_GIFT_ID_SQL: SQL = sql.raw('"gifts_and_payments"."id"');

/**
 * Settled GROSS booked against a gift across all money sources, as a numeric
 * text value ('0' when nothing is linked). This is the derived "what actually
 * landed" amount, independent of the human-entered header amount.
 */
export function settledGrossForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string> {
  return sql<string>`(
    COALESCE((
      SELECT SUM(pa.amount_applied)
      FROM payment_applications pa
      WHERE pa.gift_id = ${giftIdSql} AND pa.evidence_source = 'quickbooks'
        AND pa.link_role = 'counted'
    ), 0)
    + COALESCE((
      SELECT SUM(ssc.gross_amount)
      FROM stripe_staged_charges ssc
      WHERE ssc.matched_gift_id = ${giftIdSql} OR ssc.created_gift_id = ${giftIdSql}
    ), 0)
    + COALESCE((
      SELECT SUM(dd.amount)
      FROM donorbox_donations dd
      WHERE (dd.matched_gift_id = ${giftIdSql} OR dd.created_gift_id = ${giftIdSql})
        AND dd.donation_type IS DISTINCT FROM 'stripe'
    ), 0)
  )::text`;
}

/**
 * Total processor fees booked against a gift across all money sources, as a
 * numeric text value ('0' when nothing is linked). QuickBooks carries no
 * per-gift fee, so only Stripe + (non-stripe) Donorbox contribute.
 */
export function totalFeesForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string> {
  return sql<string>`(
    COALESCE((
      SELECT SUM(ssc.fee_amount)
      FROM stripe_staged_charges ssc
      WHERE ssc.matched_gift_id = ${giftIdSql} OR ssc.created_gift_id = ${giftIdSql}
    ), 0)
    + COALESCE((
      SELECT SUM(dd.processing_fee)
      FROM donorbox_donations dd
      WHERE (dd.matched_gift_id = ${giftIdSql} OR dd.created_gift_id = ${giftIdSql})
        AND dd.donation_type IS DISTINCT FROM 'stripe'
    ), 0)
  )::text`;
}

/**
 * EXISTS any linked payment (across QB / Stripe / non-stripe Donorbox) for the
 * gift. The reconciliation queue uses this to tell "no money has landed yet"
 * (no linked payment) apart from "money landed but the amount disagrees".
 */
export function hasLinkedPaymentForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`(
    EXISTS (
      SELECT 1 FROM payment_applications pa
      WHERE pa.gift_id = ${giftIdSql} AND pa.evidence_source = 'quickbooks'
        AND pa.link_role = 'counted'
    )
    OR EXISTS (
      SELECT 1 FROM stripe_staged_charges ssc
      WHERE ssc.matched_gift_id = ${giftIdSql} OR ssc.created_gift_id = ${giftIdSql}
    )
    OR EXISTS (
      SELECT 1 FROM donorbox_donations dd
      WHERE (dd.matched_gift_id = ${giftIdSql} OR dd.created_gift_id = ${giftIdSql})
        AND dd.donation_type IS DISTINCT FROM 'stripe'
    )
  )`;
}

/**
 * Read-model projection of the settled gross: the settled amount when ANY
 * payment is linked, else NULL (so the UI can distinguish "nothing landed yet"
 * from "settled $0"). Matches GiftOrPayment.derivedSettledAmount (nullable).
 */
export function derivedSettledAmountForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string | null> {
  return sql<string | null>`CASE WHEN ${hasLinkedPaymentForGift(giftIdSql)}
    THEN ${settledGrossForGift(giftIdSql)} ELSE NULL END`;
}

/**
 * Read-model projection of total processor fees: NULL when no fee-bearing
 * payment is linked (NULLIF on 0). Matches GiftOrPayment.derivedProcessorFee.
 */
export function derivedProcessorFeeForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string | null> {
  return sql<string | null>`NULLIF(${totalFeesForGift(giftIdSql)}::numeric, 0)::text`;
}

/**
 * Whether a gift is OFF-BOOKS / payment-exempt, DERIVED ONLY from its allocations
 * (Task #448 Steps 6-8; header terms retired in Task #594). A gift is off-books
 * exactly when it has at least one allocation AND every allocation sits on a
 * no-payment entity (entities.expects_payment = false) — e.g. the "Direct to
 * School" or "Wildflower Foundation TSNE" buckets that replaced the retired header
 * booleans `designated_to_school` / `off_books_fiscal_sponsor` / `payment_expected`.
 * A gift with no allocations, or any allocation on a payment-bearing entity (or
 * with no entity), expects payment.
 *
 * The way to make a gift off-books is to put every allocation on a no-payment
 * entity; there is no longer any header flag OR'd into this derivation.
 *
 * Correlation follows the bare-column rule (literal gift-id SQL expr).
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
  /** Whether ANY payment is linked to the gift. */
  hasLinkedPayment: boolean;
}

const toNum = (v: string | number | null | undefined): number => {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
};

/**
 * Single-gift read of the linked-payment summary, sharing the exact SQL
 * fragments the projection/queue use (bound by gift-id param, so no
 * bare-column risk). Caller may pass a tx or the db singleton.
 */
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
