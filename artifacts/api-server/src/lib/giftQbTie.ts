import { db } from "@workspace/db";
import { giftsAndPayments } from "@workspace/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { amountWithinFeeBand } from "./reconciliationGate";
import { qbLedgerExistsForGift, qbLedgerSumForGift } from "./paymentApplications";

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
  /** Whether the gift has ANY direct QuickBooks linkage. */
  hasQbLink: boolean;
  /** The QB evidence amount to compare against, or null when not QB-linked. */
  qbAmount: string | null;
  /** Final-amount provenance ('human' | 'stripe' | 'quickbooks'). */
  finalAmountSource: string | null;
}

/**
 * Pure deriver — no DB access, safe to unit-test.
 *
 *  - exempt          : off-books (fiscal-sponsor era OR designated-to-school).
 *  - tied            : QB-linked within the fee band, OR Stripe-sourced (the
 *                      money lands in QuickBooks at the payout level, not per
 *                      gift; the two-lane per-charge detail is a downstream
 *                      task and out of scope here).
 *  - amount_mismatch : QB-linked but the amount is outside the fee band.
 *  - missing         : on-books with no QuickBooks evidence at all.
 */
export function deriveGiftQbTie(input: GiftQbTieInput): GiftQbTie {
  if (input.offBooks) return "exempt";
  if (input.hasQbLink) {
    // Can't prove a mismatch without both amounts — treat as tied.
    if (input.giftAmount == null || input.qbAmount == null) return "tied";
    return amountWithinFeeBand(input.qbAmount, input.giftAmount)
      ? "tied"
      : "amount_mismatch";
  }
  if (input.finalAmountSource === "stripe") return "tied";
  return "missing";
}

interface TieRow {
  id: string;
  giftAmount: string | null;
  offBooks: boolean;
  finalAmountSource: string | null;
  qbSum: string | null;
  hasQb: boolean;
}

/**
 * Recompute and persist `quickbooks_tie_status` for the given gift ids. Reads
 * the gift + its authoritative QuickBooks cash-application ledger
 * (`payment_applications`, evidence_source = 'quickbooks') via the global `db`,
 * so call it AFTER the mutating transaction commits (same contract as
 * `applyDerivedOppFieldsMany`). De-dupes and ignores null/undefined ids.
 */
export async function applyGiftQbTieMany(
  ...ids: Array<string | null | undefined>
): Promise<void> {
  const giftIds = [...new Set(ids.filter((x): x is string => !!x))];
  if (giftIds.length === 0) return;

  // Gather, per gift, the off-books exemption inputs plus the authoritative
  // QuickBooks cash-application figure from the ledger: SUM(amount_applied) over
  // the gift's evidence_source = 'quickbooks' rows, and whether any such row
  // exists (hasQb). The ledger correlation lives in the shared helpers, which
  // take a literal, pre-qualified gift-id expression so they never hit the
  // drizzle bare-column footgun (see paymentApplications.ts). The off-books /
  // final_amount_source expressions are top-level (single FROM table), so column
  // interpolation is safe there.
  const rows = (await db
    .select({
      id: giftsAndPayments.id,
      giftAmount: giftsAndPayments.amount,
      offBooks: sql<boolean>`(${giftsAndPayments.offBooksFiscalSponsor} OR ${giftsAndPayments.designatedToSchool} OR NOT ${giftsAndPayments.paymentExpected})`,
      finalAmountSource: giftsAndPayments.finalAmountSource,
      qbSum: qbLedgerSumForGift(),
      hasQb: qbLedgerExistsForGift(),
    })
    .from(giftsAndPayments)
    .where(inArray(giftsAndPayments.id, giftIds))) as TieRow[];

  for (const r of rows) {
    const status = deriveGiftQbTie({
      offBooks: r.offBooks,
      giftAmount: r.giftAmount,
      hasQbLink: r.hasQb,
      qbAmount: r.hasQb ? r.qbSum : null,
      finalAmountSource: r.finalAmountSource,
    });

    await db
      .update(giftsAndPayments)
      .set({ quickbooksTieStatus: status })
      .where(eq(giftsAndPayments.id, r.id));
  }
}
