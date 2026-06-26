import { db } from "@workspace/db";
import {
  giftsAndPayments,
  giftAllocations,
  giftAmountAllocationReview,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { newId } from "./helpers";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Reconciliation primitives for the model in which the CRM gift is the single
 * source of truth and Stripe charges / QuickBooks staged rows are permanent
 * EVIDENCE tied to it — never a second gift, never archived.
 */

/** Processor reconciliation sources that can stamp a gift's final amount. A
 * `human` gift is the unstamped default and is never produced by these helpers. */
export type StampSource = "stripe" | "quickbooks";

export interface StampFinalAmountArgs {
  source: StampSource;
  /** Required when source = 'stripe': the charge the amount was taken from. */
  stripeChargeId?: string | null;
  /** Required when source = 'quickbooks': the staged row the amount came from. */
  qbStagedPaymentId?: string | null;
  /** The new FINAL gift amount (Stripe GROSS, or the QB staged amount). */
  amount: string | null;
  /** Processor fee withheld (Stripe only); ignored for QuickBooks. */
  processorFee?: string | null;
}

export interface StampResult {
  oldAmount: string | null;
  newAmount: string | null;
  /** True when the stamp actually changed the stored amount. */
  changed: boolean;
  /**
   * True when the stamp was a no-op because Stripe precedence blocked it: a
   * QuickBooks stamp was refused on a gift already sourced from Stripe. The
   * caller should NOT mark its QB evidence row as the amount source, but may
   * still record the reconciliation linkage (the money is already accounted
   * for from the Stripe charge).
   */
  skipped: boolean;
}

/** Numeric-string equality with a half-cent tolerance (null == null). */
function amountsEqual(a: string | null, b: string | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return a === b;
  return Math.abs(na - nb) < 0.005;
}

/**
 * Stamp a CRM gift's FINAL amount from reconciliation evidence, recording the
 * provenance so the gift stays tied permanently to the Stripe charge /
 * QuickBooks staged row WITHOUT that evidence becoming a second gift.
 *
 * - Snapshots original_human_crm_amount from the CURRENT amount the first time
 *   the gift is stamped (so the human-entered figure is never lost).
 * - Sets amount, final_amount_source, and the single XOR pointer for the source
 *   (clearing the other), plus processor_fee for Stripe.
 *
 * Caller MUST hold an open transaction and is responsible for rebalancing the
 * gift's allocations afterward (see adjustSingleAllocationOrFlag).
 */
export async function stampGiftFinalAmount(
  tx: Tx,
  giftId: string,
  args: StampFinalAmountArgs,
): Promise<StampResult> {
  const stripeChargeId =
    args.source === "stripe" ? (args.stripeChargeId ?? null) : null;
  const qbStagedPaymentId =
    args.source === "quickbooks" ? (args.qbStagedPaymentId ?? null) : null;
  if (args.source === "stripe" && !stripeChargeId) {
    throw new Error(
      "stampGiftFinalAmount: stripe source requires stripeChargeId",
    );
  }
  if (args.source === "quickbooks" && !qbStagedPaymentId) {
    throw new Error(
      "stampGiftFinalAmount: quickbooks source requires qbStagedPaymentId",
    );
  }

  const gift = await tx
    .select({
      amount: giftsAndPayments.amount,
      originalHumanCrmAmount: giftsAndPayments.originalHumanCrmAmount,
      finalAmountSource: giftsAndPayments.finalAmountSource,
    })
    .from(giftsAndPayments)
    .where(eq(giftsAndPayments.id, giftId))
    .for("update")
    .then((r) => r[0]);
  if (!gift) throw new Error(`stampGiftFinalAmount: gift ${giftId} not found`);

  // Stripe precedence (authoritative guard). A Stripe stamp is the source of
  // truth (GROSS) and may overwrite a prior `human` or `quickbooks` stamp; the
  // XOR pointer write below clears the QB pointer for us. But a QuickBooks stamp
  // must NEVER override a gift already sourced from Stripe — skip it as an
  // idempotent no-op so QB reconcile of the same money leaves the Stripe figure
  // intact. Held under the row lock above, so concurrent QB/Stripe stamps of the
  // same gift serialize and this check always sees the committed winner.
  if (args.source === "quickbooks" && gift.finalAmountSource === "stripe") {
    return {
      oldAmount: gift.amount,
      newAmount: gift.amount,
      changed: false,
      skipped: true,
    };
  }

  const oldAmount = gift.amount;

  // QuickBooks settlement (Phase 2: payment_applications rollout). A QB stamp no
  // longer overwrites the gift's human-entered amount — the QB-settled figure
  // now lives in the payment_applications ledger, and giftQbTie compares that
  // ledger SUM against the (preserved) human amount. We STILL record the
  // provenance pointer: live readers (gifts-missing-qb, financialCorrections)
  // filter on final_amount_qb_staged_payment_id, and the schema's
  // source⇔pointer CHECK requires it. `amount` and `original_human_crm_amount`
  // are deliberately left untouched, so the QB revert (unstampGiftFinalAmount,
  // which restores amount ← original_human_crm_amount ?? amount) is a correct
  // no-op for the amount. changed=false ⇒ callers' adjustSingleAllocationOrFlag
  // no-ops (no rescale of allocations to the QB figure).
  if (args.source === "quickbooks") {
    await tx
      .update(giftsAndPayments)
      .set({
        finalAmountSource: "quickbooks",
        finalAmountStripeChargeId: null,
        finalAmountQbStagedPaymentId: qbStagedPaymentId,
        updatedAt: new Date(),
      })
      .where(eq(giftsAndPayments.id, giftId));
    return { oldAmount, newAmount: oldAmount, changed: false, skipped: false };
  }

  // Stripe settlement (Task #448): the gift's settled amount is now DERIVED at
  // read time from the linked Stripe charge (gross) + Donorbox/QB ledger — see
  // giftPaymentSummary. So a Stripe stamp NO LONGER overwrites the human-entered
  // `amount`; it only records the provenance pointer (deprecated, still read by
  // transitional reconciliation code until those readers are retired). `amount`,
  // `processor_fee`, and `original_human_crm_amount` are left untouched so the
  // entered figure is preserved and any settled≠entered disagreement surfaces in
  // the reconciliation queue instead of silently rescaling allocations.
  // changed=false ⇒ callers' adjustSingleAllocationOrFlag no-ops.
  await tx
    .update(giftsAndPayments)
    .set({
      finalAmountSource: "stripe",
      finalAmountStripeChargeId: stripeChargeId,
      finalAmountQbStagedPaymentId: null,
      updatedAt: new Date(),
    })
    .where(eq(giftsAndPayments.id, giftId));

  return { oldAmount, newAmount: oldAmount, changed: false, skipped: false };
}

export interface UnstampArgs {
  source: StampSource;
  /** Required when source = 'stripe': the charge whose stamp is being reverted. */
  stripeChargeId?: string | null;
  /** Required when source = 'quickbooks': the staged row being reverted. */
  qbStagedPaymentId?: string | null;
}

export interface UnstampResult {
  /** True when the stamp was actually reverted (pointer matched, source matched). */
  restored: boolean;
  /** The stamped amount before revert (only meaningful when restored). */
  oldAmount: string | null;
  /** The restored original human amount (only meaningful when restored). */
  newAmount: string | null;
}

/**
 * Reverse stampGiftFinalAmount: restore a gift to its original human-entered
 * amount and the `human` provenance default when the reconciliation evidence
 * that stamped it is being undone (revert/unmatch).
 *
 * Pointer-safe — a STRICT no-op unless the gift's CURRENT final_amount_source
 * still equals the reverting `source` AND its single XOR pointer still equals
 * the reverting evidence id. This guarantees:
 *   - a QB stamp later SUPERSEDED by a Stripe stamp (source flipped to 'stripe',
 *     QB pointer cleared) is never clobbered when the QB evidence is reverted;
 *   - reverting one Stripe charge can't disturb a gift now stamped from another.
 *
 * On restore: amount ← original_human_crm_amount (snapshot), source ← 'human',
 * both pointers ← NULL, original_human_crm_amount ← NULL, and processor_fee is
 * cleared for the Stripe path (QuickBooks never set it). Caller MUST hold an
 * open transaction and is responsible for rebalancing allocations afterward
 * (see adjustSingleAllocationOrFlag) exactly as the stamp path does.
 */
export async function unstampGiftFinalAmount(
  tx: Tx,
  giftId: string,
  args: UnstampArgs,
): Promise<UnstampResult> {
  const noop: UnstampResult = {
    restored: false,
    oldAmount: null,
    newAmount: null,
  };

  const gift = await tx
    .select({
      amount: giftsAndPayments.amount,
      originalHumanCrmAmount: giftsAndPayments.originalHumanCrmAmount,
      finalAmountSource: giftsAndPayments.finalAmountSource,
      finalAmountStripeChargeId: giftsAndPayments.finalAmountStripeChargeId,
      finalAmountQbStagedPaymentId:
        giftsAndPayments.finalAmountQbStagedPaymentId,
    })
    .from(giftsAndPayments)
    .where(eq(giftsAndPayments.id, giftId))
    .for("update")
    .then((r) => r[0]);
  // Gift may legitimately be gone (e.g. an auto-minted gift deleted in the same
  // revert) — treat as a no-op rather than throwing.
  if (!gift) return noop;

  // Source must still be the one we're reverting.
  if (gift.finalAmountSource !== args.source) return noop;

  // …and the single XOR pointer must still be THIS evidence.
  if (args.source === "stripe") {
    if (
      !args.stripeChargeId ||
      gift.finalAmountStripeChargeId !== args.stripeChargeId
    ) {
      return noop;
    }
  } else {
    if (
      !args.qbStagedPaymentId ||
      gift.finalAmountQbStagedPaymentId !== args.qbStagedPaymentId
    ) {
      return noop;
    }
  }

  const oldAmount = gift.amount;
  const newAmount = gift.originalHumanCrmAmount ?? gift.amount;
  await tx
    .update(giftsAndPayments)
    .set({
      amount: newAmount,
      ...(args.source === "stripe" ? { processorFee: null } : {}),
      originalHumanCrmAmount: null,
      finalAmountSource: "human",
      finalAmountStripeChargeId: null,
      finalAmountQbStagedPaymentId: null,
      updatedAt: new Date(),
    })
    .where(eq(giftsAndPayments.id, giftId));

  return { restored: true, oldAmount, newAmount };
}

export interface AllocationAdjustResult {
  rescaled: boolean;
  flagged: boolean;
}

/**
 * Reconcile a gift's allocations to a newly-stamped amount.
 *
 *   - exactly 1 allocation → rescale its sub_amount to the new amount.
 *   - 0 allocations, or 2+ whose sub_amounts no longer sum to the new amount →
 *     leave them ALONE (never silently guess a split) and drop/refresh an OPEN
 *     gift_amount_allocation_review row for a human to re-apportion.
 *
 * No-op when the amount didn't change, when 2+ allocations already sum to the
 * new amount, or when a 0-allocation gift has no money to place. Caller MUST
 * hold the same open transaction that stamped the amount.
 */
export async function adjustSingleAllocationOrFlag(
  tx: Tx,
  giftId: string,
  oldAmount: string | null,
  newAmount: string | null,
  source: StampSource,
): Promise<AllocationAdjustResult> {
  if (amountsEqual(oldAmount, newAmount)) {
    return { rescaled: false, flagged: false };
  }

  const allocs = await tx
    .select({ id: giftAllocations.id, subAmount: giftAllocations.subAmount })
    .from(giftAllocations)
    .where(eq(giftAllocations.giftId, giftId))
    .for("update");

  if (allocs.length === 1 && allocs[0]) {
    await tx
      .update(giftAllocations)
      .set({ subAmount: newAmount, updatedAt: new Date() })
      .where(eq(giftAllocations.id, allocs[0].id));
    return { rescaled: true, flagged: false };
  }

  // 0 or >= 2 allocations: only flag a genuine mismatch.
  const sum = allocs.reduce((acc, a) => acc + Number(a.subAmount ?? 0), 0);
  const target = newAmount == null ? 0 : Number(newAmount);
  if (allocs.length >= 2 && Math.abs(sum - target) < 0.005) {
    return { rescaled: false, flagged: false };
  }
  if (allocs.length === 0 && target === 0) {
    return { rescaled: false, flagged: false };
  }

  const reason =
    allocs.length === 0 ? "no_allocation" : "multi_allocation_mismatch";
  await tx
    .insert(giftAmountAllocationReview)
    .values({
      id: newId(),
      giftId,
      source,
      oldAmount,
      newAmount,
      allocationCount: allocs.length,
      reason,
    })
    .onConflictDoUpdate({
      target: giftAmountAllocationReview.giftId,
      targetWhere: sql`resolved_at IS NULL`,
      set: {
        source,
        oldAmount,
        newAmount,
        allocationCount: allocs.length,
        reason,
        updatedAt: new Date(),
      },
    });
  return { rescaled: false, flagged: true };
}
