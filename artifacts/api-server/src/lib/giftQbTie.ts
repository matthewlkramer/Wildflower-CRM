import { sql, type SQL } from "drizzle-orm";
import { amountWithinFeeBand } from "./reconciliationGate";
import {
  qbLedgerExistsForGift,
  qbLedgerSumForGift,
  stripeLedgerExistsForGift,
  stripeLedgerSumForGift,
  stripeLedgerNetSumForGift,
  donorboxLedgerExistsForGift,
  donorboxLedgerSumForGift,
} from "./paymentApplications";
import { giftIsOffBooksExpr } from "./giftPaymentSummary";

/**
 * Per-gift QuickBooks-tie derivation (INV-2 / INV-3 / INV-10).
 *
 * `quickbooks_tie_status` is now a LIVE-DERIVED signal computed at query time
 * by `deriveGiftQbTieLiveExpr` (Task #451). There is no stored column to update
 * and no applier to call after mutations — the status is always fresh.
 *
 * The derivation reads the same gross-vs-net fee tolerance the reconciler uses
 * (`amountWithinFeeBand`) so the computed value agrees with the gate.
 */

export type GiftQbTie = "exempt" | "tied" | "amount_mismatch" | "missing";

export interface GiftQbTieInput {
  /**
   * Derived off-books flag (`giftIsOffBooksExpr`): true when the gift has at
   * least one allocation and EVERY allocation sits on a no-payment entity
   * (`entities.expects_payment = false`). Being off-books exempts the gift from
   * the QB-tie requirement.
   */
  offBooks: boolean;
  /** Gift's final amount (gross), or null when unknown. */
  giftAmount: string | null;
  /**
   * Whether the gift has ANY counted cash-application ledger row — from
   * QuickBooks, Stripe, or Donorbox. Source-agnostic (§4.4): the money is
   * accounted-for evidence regardless of which processor booked it.
   */
  hasLink: boolean;
  /**
   * The per-source-PRECEDENCE-resolved evidence amount to compare against (QB
   * sum wins, else Stripe, else Donorbox), or null when unlinked. Precedence,
   * not a cross-source SUM — see the ledger readers.
   */
  linkAmount: string | null;
}

/**
 * Pure deriver — no DB access, safe to unit-test.
 *
 *  - exempt          : off-books (every allocation on a no-payment entity).
 *  - tied            : linked to counted evidence (QB / Stripe / Donorbox)
 *                      within the fee band, or linked with an unknown amount
 *                      (can't prove a mismatch).
 *  - amount_mismatch : linked but the evidence amount is outside the fee band.
 *  - missing         : on-books with no counted evidence of any source.
 *
 * NOTE: the legacy amount-BLIND `finalAmountSource === 'stripe'` shortcut is
 * gone — a Stripe-settled gift now ties through its own counted Stripe ledger
 * rows (dual-written by the reconciler / sync), with a real amount compare.
 */
export function deriveGiftQbTie(input: GiftQbTieInput): GiftQbTie {
  if (input.offBooks) return "exempt";
  if (!input.hasLink) return "missing";
  // Can't prove a mismatch without both amounts — treat as tied.
  if (input.giftAmount == null || input.linkAmount == null) return "tied";
  return amountWithinFeeBand(input.linkAmount, input.giftAmount)
    ? "tied"
    : "amount_mismatch";
}

/**
 * Live Drizzle SQL CASE expression that computes the QB-tie status for each
 * gift row at query time, replacing the retired stored `quickbooks_tie_status`
 * column (Task #451). Compose into any SELECT or WHERE that runs against
 * the un-aliased `gifts_and_payments` table (the default column qualifiers
 * are "gifts_and_payments"."id" / "gifts_and_payments"."amount").
 *
 * Precedence is identical to the retired `applyGiftQbTieMany` applier:
 *   exempt         — every allocation on a no-payment entity (off-books).
 *   missing        — on-books, no counted ledger row of any source.
 *   tied           — linked and amount within the processor fee band.
 *   amount_mismatch— linked but amount outside the fee band.
 *
 * Source precedence (never cross-source SUM): QB > Stripe > Donorbox.
 * Fee band: gift >= evidence − ½¢  AND  gift ≤ evidence × 1.1 + 1.
 * Stripe evidence ties at EITHER the charge gross or its fee-net sum —
 * whether the gift was booked gross or net is a QBO-plane accounting fact,
 * not a money-identity mismatch.
 */
export function deriveGiftQbTieLiveExpr(): SQL<string> {
  const hasQb = qbLedgerExistsForGift();
  const sumQb = qbLedgerSumForGift();
  const hasStripe = stripeLedgerExistsForGift();
  const sumStripe = stripeLedgerSumForGift();
  const netStripe = stripeLedgerNetSumForGift();
  const hasDonorbox = donorboxLedgerExistsForGift();
  const sumDonorbox = donorboxLedgerSumForGift();
  const offBooks = giftIsOffBooksExpr();
  const amount = sql.raw('"gifts_and_payments"."amount"');

  return sql<string>`CASE
    WHEN ${offBooks} THEN 'exempt'
    WHEN NOT (${hasQb} OR ${hasStripe} OR ${hasDonorbox}) THEN 'missing'
    WHEN ${amount} IS NULL THEN 'tied'
    WHEN ${hasQb}
      AND ${amount}::numeric >= ${sumQb}::numeric - 0.01
      AND ${amount}::numeric <= ${sumQb}::numeric * 1.1 + 1
      THEN 'tied'
    WHEN NOT ${hasQb} AND ${hasStripe}
      AND ((${amount}::numeric >= ${sumStripe}::numeric - 0.01
            AND ${amount}::numeric <= ${sumStripe}::numeric * 1.1 + 1)
        OR (${amount}::numeric >= ${netStripe}::numeric - 0.01
            AND ${amount}::numeric <= ${netStripe}::numeric * 1.1 + 1))
      THEN 'tied'
    WHEN NOT ${hasQb} AND NOT ${hasStripe} AND ${hasDonorbox}
      AND ${amount}::numeric >= ${sumDonorbox}::numeric - 0.01
      AND ${amount}::numeric <= ${sumDonorbox}::numeric * 1.1 + 1
      THEN 'tied'
    ELSE 'amount_mismatch'
  END`;
}

/**
 * Raw-SQL string version of the QB-tie live derivation for contexts where the
 * gifts_and_payments table is referenced through an alias (e.g. in raw-SQL
 * strings passed to db.execute / sql.raw). Uses `pa_qbt` as the internal
 * alias prefix to avoid clashing with surrounding `pa` aliases.
 *
 * @param giftIdRef   SQL expression for the gift id, e.g. "g.id".
 * @param amountRef   SQL expression for the gift amount, e.g. "g.amount".
 */
export function deriveGiftQbTieLiveRaw(
  giftIdRef: string,
  amountRef: string,
): string {
  const qbWhere = `pu_qbt.gift_id = ${giftIdRef} AND pu_qbt.source_staged_payment_id IS NOT NULL`;
  const stripeWhere = `pu_qbt.gift_id = ${giftIdRef} AND pu_qbt.stripe_charge_id IS NOT NULL`;
  const donorboxWhere = `pu_qbt.gift_id = ${giftIdRef} AND pu_qbt.donorbox_donation_id IS NOT NULL AND pu_qbt.stripe_charge_id IS NULL AND pu_qbt.source_staged_payment_id IS NULL`;
  const qbEx = `EXISTS (SELECT 1 FROM payment_units pu_qbt WHERE ${qbWhere})`;
  const stripeEx = `EXISTS (SELECT 1 FROM payment_units pu_qbt WHERE ${stripeWhere})`;
  const donorboxEx = `EXISTS (SELECT 1 FROM payment_units pu_qbt WHERE ${donorboxWhere})`;
  const qbSum = `(SELECT COALESCE(SUM(pu_qbt.gross_amount), 0) FROM payment_units pu_qbt WHERE ${qbWhere})`;
  const stripeSum = `(SELECT COALESCE(SUM(pu_qbt.gross_amount), 0) FROM payment_units pu_qbt WHERE ${stripeWhere})`;
  const stripeNetSum = `(SELECT COALESCE(SUM(COALESCE(pu_qbt.net_amount, pu_qbt.gross_amount)), 0) FROM payment_units pu_qbt WHERE ${stripeWhere})`;
  const donorboxSum = `(SELECT COALESCE(SUM(pu_qbt.gross_amount), 0) FROM payment_units pu_qbt WHERE ${donorboxWhere})`;
  const offBooks = `(EXISTS (SELECT 1 FROM gift_allocations ga_qbt WHERE ga_qbt.gift_id = ${giftIdRef}) AND NOT EXISTS (SELECT 1 FROM gift_allocations ga_qbt LEFT JOIN entities e_qbt ON e_qbt.id = ga_qbt.entity_id WHERE ga_qbt.gift_id = ${giftIdRef} AND (ga_qbt.entity_id IS NULL OR COALESCE(e_qbt.expects_payment, true) = true)))`;

  return `(CASE
    WHEN ${offBooks} THEN 'exempt'
    WHEN NOT (${qbEx} OR ${stripeEx} OR ${donorboxEx}) THEN 'missing'
    WHEN ${amountRef} IS NULL THEN 'tied'
    WHEN ${qbEx}
      AND ${amountRef}::numeric >= (${qbSum}) - 0.01
      AND ${amountRef}::numeric <= (${qbSum}) * 1.1 + 1
      THEN 'tied'
    WHEN NOT ${qbEx} AND ${stripeEx}
      AND ((${amountRef}::numeric >= (${stripeSum}) - 0.01
            AND ${amountRef}::numeric <= (${stripeSum}) * 1.1 + 1)
        OR (${amountRef}::numeric >= (${stripeNetSum}) - 0.01
            AND ${amountRef}::numeric <= (${stripeNetSum}) * 1.1 + 1))
      THEN 'tied'
    WHEN NOT ${qbEx} AND NOT ${stripeEx} AND ${donorboxEx}
      AND ${amountRef}::numeric >= (${donorboxSum}) - 0.01
      AND ${amountRef}::numeric <= (${donorboxSum}) * 1.1 + 1
      THEN 'tied'
    ELSE 'amount_mismatch'
  END)`;
}
