import { db } from "@workspace/db";
import { giftsAndPayments } from "@workspace/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { amountWithinFeeBand } from "./reconciliationGate";
import {
  qbLedgerExistsForGift,
  qbLedgerSumForGift,
  stripeLedgerExistsForGift,
  stripeLedgerSumForGift,
  donorboxLedgerExistsForGift,
  donorboxLedgerSumForGift,
} from "./paymentApplications";
import { giftIsOffBooksExpr } from "./giftPaymentSummary";

/**
 * Per-gift QuickBooks-tie derivation (INV-2 / INV-3 / INV-10).
 *
 * `quickbooks_tie_status` is a DERIVED but PERSISTED signal on each gift,
 * recomputed by `applyGiftQbTieMany` at every gift link/amount mutation (and
 * backfilled / repaired by the catch-all in the sync worker + the backfill
 * script). It is never hand-set. Mirrors the established "derive + persist with
 * an applier" pattern used for opportunity status (`applyDerivedOppFields`).
 *
 * The derivation reads the same gross-vs-net fee tolerance the reconciler uses
 * (`amountWithinFeeBand`) so the persisted flag agrees with the gate.
 */

export type GiftQbTie = "exempt" | "tied" | "amount_mismatch" | "missing";

export interface GiftQbTieInput {
  /**
   * off_books_fiscal_sponsor OR designated_to_school OR NOT payment_expected
   * (any of the three exempts the gift from the QB-tie requirement).
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
   * not a cross-source SUM — see `applyGiftQbTieMany` / the ledger readers.
   */
  linkAmount: string | null;
}

/**
 * Pure deriver — no DB access, safe to unit-test.
 *
 *  - exempt          : off-books (fiscal-sponsor era OR designated-to-school).
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

interface TieRow {
  id: string;
  giftAmount: string | null;
  offBooks: boolean;
  qbSum: string | null;
  hasQb: boolean;
  stripeSum: string | null;
  hasStripe: boolean;
  donorboxSum: string | null;
  hasDonorbox: boolean;
}

/**
 * Recompute and persist `quickbooks_tie_status` for the given gift ids. Reads
 * the gift + its authoritative cash-application ledger (`payment_applications`,
 * all counted evidence sources) via the global `db`, so call it AFTER the
 * mutating transaction commits (same contract as `applyDerivedOppFieldsMany`).
 * De-dupes and ignores null/undefined ids.
 */
export async function applyGiftQbTieMany(
  ...ids: Array<string | null | undefined>
): Promise<void> {
  const giftIds = [...new Set(ids.filter((x): x is string => !!x))];
  if (giftIds.length === 0) return;

  // Gather, per gift, the off-books exemption inputs plus the counted
  // cash-application figures from the ledger — SUM(amount_applied) + existence,
  // ONE per evidence source (QB / Stripe / Donorbox). The ledger correlations
  // live in the shared helpers, which take a literal, pre-qualified gift-id
  // expression so they never hit the drizzle bare-column footgun (see
  // paymentApplications.ts). The off-books expression is top-level (single FROM
  // table), so column interpolation is safe there.
  const rows = (await db
    .select({
      id: giftsAndPayments.id,
      giftAmount: giftsAndPayments.amount,
      offBooks: giftIsOffBooksExpr(),
      qbSum: qbLedgerSumForGift(),
      hasQb: qbLedgerExistsForGift(),
      stripeSum: stripeLedgerSumForGift(),
      hasStripe: stripeLedgerExistsForGift(),
      donorboxSum: donorboxLedgerSumForGift(),
      hasDonorbox: donorboxLedgerExistsForGift(),
    })
    .from(giftsAndPayments)
    .where(inArray(giftsAndPayments.id, giftIds))) as TieRow[];

  for (const r of rows) {
    // PER-SOURCE PRECEDENCE (not a cross-source SUM): QB sum wins, else Stripe,
    // else Donorbox. A gift settled by both a coarse QB deposit line and its
    // per-charge Stripe rows carries a counted row of EACH source; summing them
    // would double-count (§4.3). Precedence counts exactly one source. Presence
    // is any counted row of any source.
    const hasLink = r.hasQb || r.hasStripe || r.hasDonorbox;
    const linkAmount = r.hasQb
      ? r.qbSum
      : r.hasStripe
        ? r.stripeSum
        : r.hasDonorbox
          ? r.donorboxSum
          : null;
    const status = deriveGiftQbTie({
      offBooks: r.offBooks,
      giftAmount: r.giftAmount,
      hasLink,
      linkAmount,
    });

    await db
      .update(giftsAndPayments)
      .set({ quickbooksTieStatus: status })
      .where(eq(giftsAndPayments.id, r.id));
  }
}
