import type { db } from "@workspace/db";
import { paymentApplications, stripeStagedCharges } from "@workspace/db/schema";
import { and, eq, ne, or } from "drizzle-orm";
import { proposeStripeChargeApplication } from "./paymentApplications";
import { chargeStatusWhere } from "./derivedStatus";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Record a high-confidence Stripe suggestion as a proposed ledger application.
 *
 * This is deliberately conservative:
 * - the exact immutable charge id is locked and must still be pending;
 * - a gift already claimed by any active counted QuickBooks or Stripe
 *   application is left for human review;
 * - no legacy matched_gift_id / created_gift_id pointer is written;
 * - proposed applications do not enter money totals or book-once math.
 */
export async function proposeStripeAutoApplyInTx(
  tx: Tx,
  args: { chargeId: string; giftId: string },
): Promise<boolean> {
  const charge = await tx
    .select({ id: stripeStagedCharges.id, grossAmount: stripeStagedCharges.grossAmount })
    .from(stripeStagedCharges)
    .where(and(eq(stripeStagedCharges.id, args.chargeId), chargeStatusWhere.pending))
    .for("update")
    .then((rows) => rows[0]);

  if (!charge) return false;

  const conflictingOwner = await tx
    .select({ id: paymentApplications.id })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.giftId, args.giftId),
        eq(paymentApplications.linkRole, "counted"),
        or(
          eq(paymentApplications.lifecycle, "proposed"),
          eq(paymentApplications.lifecycle, "confirmed"),
        ),
        or(
          eq(paymentApplications.evidenceSource, "quickbooks"),
          and(
            eq(paymentApplications.evidenceSource, "stripe"),
            ne(paymentApplications.stripeChargeId, args.chargeId),
          ),
        ),
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
      updatedAt: new Date(),
    })
    .where(eq(stripeStagedCharges.id, charge.id));

  return true;
}
