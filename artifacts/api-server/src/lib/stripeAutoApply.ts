import type { db } from "@workspace/db";
import {
  giftsAndPayments,
  paymentApplications,
  stripeStagedCharges,
} from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { proposeStripeChargeApplication } from "./paymentApplications";
import { chargeStatusWhere } from "./derivedStatus";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Record a high-confidence Stripe suggestion as a proposed ledger application.
 *
 * This is deliberately conservative:
 * - the exact immutable charge id is locked and must still be pending;
 * - the target gift is locked to serialize competing processor-unit claims;
 * - a gift already claimed by any active counted QBO, Stripe, or Donorbox
 *   application is left for human review;
 * - no legacy matched_gift_id / created_gift_id pointer is written;
 * - proposed applications do not enter money totals or book-once math.
 */
export async function proposeStripeAutoApplyInTx(
  tx: Tx,
  args: { chargeId: string; giftId: string },
): Promise<boolean> {
  const charge = await tx
    .select({
      id: stripeStagedCharges.id,
      grossAmount: stripeStagedCharges.grossAmount,
    })
    .from(stripeStagedCharges)
    .where(
      and(eq(stripeStagedCharges.id, args.chargeId), chargeStatusWhere.pending),
    )
    .for("update")
    .then((rows) => rows[0]);
  if (!charge) return false;

  const gift = await tx
    .select({ id: giftsAndPayments.id })
    .from(giftsAndPayments)
    .where(eq(giftsAndPayments.id, args.giftId))
    .for("update")
    .then((rows) => rows[0]);
  if (!gift) return false;

  const conflictingOwner = await tx
    .select({ id: paymentApplications.id })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.giftId, args.giftId),
        eq(paymentApplications.linkRole, "counted"),
        inArray(paymentApplications.lifecycle, ["proposed", "confirmed"]),
      ),
    )
    .limit(1);
  if (conflictingOwner.length > 0) return false;
  if (!charge.grossAmount || Number(charge.grossAmount) <= 0) return false;

  await proposeStripeChargeApplication(tx, {
    stripeChargeId: charge.id,
    grossAmount: charge.grossAmount,
    giftId: args.giftId,
  });

  await tx
    .update(stripeStagedCharges)
    .set({
      autoApplied: true,
      matchStatus: "matched",
      matchConfirmedByUserId: null,
      matchConfirmedAt: null,
      approvedByUserId: null,
      approvedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(stripeStagedCharges.id, charge.id));

  return true;
}
