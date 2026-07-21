import { db } from "@workspace/db";
import {
  giftAllocations,
  giftAmountAllocationReview,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { newId } from "./helpers";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Reconciliation primitive for the model in which the CRM gift is the single
 * source of truth and Stripe charges / QuickBooks staged rows are permanent
 * EVIDENCE tied to it — never a second gift, never archived.
 *
 * The stamp/unstamp final-amount provenance helpers were RETIRED (Task #757):
 * `amount` is never overwritten by reconciliation, settled money is derived
 * from the payment_applications ledger (giftPaymentSummary.ts), and the
 * transitional final_amount_source / original_human_crm_amount header columns
 * are no longer written or read.
 */

/** Processor reconciliation sources that can drive an allocation adjustment. */
export type StampSource = "stripe" | "quickbooks";

/** Numeric-string equality with a half-cent tolerance (null == null). */
function amountsEqual(a: string | null, b: string | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return a === b;
  return Math.abs(na - nb) < 0.005;
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
