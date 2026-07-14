import type { db } from "@workspace/db";
import { stripeStagedCharges } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  adjustSingleAllocationOrFlag,
  unstampGiftFinalAmount,
} from "./giftFinalAmount";
import { isFullyRefunded } from "./stripeRefund";
import { removeStripeChargeApplicationsAndRefresh } from "./paymentApplicationMutations";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface OrphanStripeSourceResult {
  affectedGiftIds: string[];
}

/**
 * Release the Stripe charge currently funding a gift so another exact charge can
 * become its source.
 *
 * Caller contract: the gift and old charge are already locked FOR UPDATE. The
 * payment application is removed first, which also recomputes settlement
 * supersession. The final-amount stamp is then unwound before the new charge is
 * linked and stamped by the caller.
 */
export async function orphanStripeSourceChargeLedgerInTx(
  tx: Tx,
  args: {
    oldCharge: typeof stripeStagedCharges.$inferSelect;
    giftId: string;
  },
): Promise<OrphanStripeSourceResult> {
  const { oldCharge, giftId } = args;
  const removal = await removeStripeChargeApplicationsAndRefresh(
    tx,
    oldCharge.id,
  );

  const unstamped = await unstampGiftFinalAmount(tx, giftId, {
    source: "stripe",
    stripeChargeId: oldCharge.id,
  });
  if (unstamped.restored) {
    await adjustSingleAllocationOrFlag(
      tx,
      giftId,
      unstamped.oldAmount,
      unstamped.newAmount,
      "stripe",
    );
  }

  const hasDonor =
    oldCharge.organizationId != null ||
    oldCharge.individualGiverPersonId != null ||
    oldCharge.householdId != null;
  const rawStatus =
    oldCharge.rawCharge && typeof oldCharge.rawCharge === "object"
      ? ((oldCharge.rawCharge as Record<string, unknown>)["status"] ?? null)
      : null;
  const exclusionReason =
    rawStatus === "failed"
      ? ("failed_charge" as const)
      : isFullyRefunded({
            refunded: oldCharge.refunded === true,
            disputed: oldCharge.disputed === true,
            amountRefunded: oldCharge.amountRefunded,
            grossAmount: oldCharge.grossAmount,
          })
        ? ("refunded_charge" as const)
        : null;

  await tx
    .update(stripeStagedCharges)
    .set({
      exclusionReason,
      // Clear transition-era duplicates if they are still populated. No new
      // relationship is written here; payment_applications remains authoritative.
      matchedGiftId: null,
      createdGiftId: null,
      autoApplied: false,
      matchStatus: hasDonor ? "suggested" : "unmatched",
      matchConfirmedAt: null,
      matchConfirmedByUserId: null,
      approvedAt: null,
      approvedByUserId: null,
      ...(oldCharge.refundPropagationStatus === "proposed"
        ? {
            refundPropagationStatus: "none" as const,
            refundPropagationKind: null,
            refundPropagationGiftId: null,
            refundProposedAmount: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(stripeStagedCharges.id, oldCharge.id));

  return {
    affectedGiftIds: [
      ...new Set([giftId, ...removal.affectedGiftIds]),
    ],
  };
}
