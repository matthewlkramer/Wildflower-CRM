import type { db } from "@workspace/db";
import {
  donorboxDonations,
  paymentUnits,
  stagedPayments,
  stripeStagedCharges,
} from "@workspace/db/schema";
import { eq, or, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = Pick<Tx, "select" | "insert" | "update">;

export type PaymentUnitSource = "quickbooks" | "stripe" | "donorbox";

function anchorPredicate(source: PaymentUnitSource, anchorId: string) {
  return source === "quickbooks"
    ? eq(paymentUnits.sourceStagedPaymentId, anchorId)
    : source === "stripe"
      ? eq(paymentUnits.stripeChargeId, anchorId)
      : eq(paymentUnits.donorboxDonationId, anchorId);
}

/**
 * Ensure the canonical unit for an evidence anchor exists and return its id.
 *
 * The derivations here intentionally mirror bankSpineRecompute's fill-only
 * projections: deterministic ids, source-specific kind and amounts, and
 * received/refund lifecycle facts. The insert is idempotent so callers can
 * safely use it while holding the source-row lock.
 */
export async function ensurePaymentUnit(
  tx: DbLike,
  source: PaymentUnitSource,
  anchorId: string,
): Promise<string> {
  const existing = await tx
    .select({ id: paymentUnits.id })
    .from(paymentUnits)
    .where(anchorPredicate(source, anchorId))
    .then((rows) => rows[0]?.id);
  if (existing) return existing;

  if (source === "stripe") {
    const charge = await tx
      .select({
        grossAmount: stripeStagedCharges.grossAmount,
        feeAmount: stripeStagedCharges.feeAmount,
        netAmount: stripeStagedCharges.netAmount,
        currency: stripeStagedCharges.currency,
        dateReceived: stripeStagedCharges.dateReceived,
        disputed: stripeStagedCharges.disputed,
        refunded: stripeStagedCharges.refunded,
        amountRefunded: stripeStagedCharges.amountRefunded,
      })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, anchorId))
      .then((rows) => rows[0]);
    if (!charge) throw new Error(`payment unit source ${anchorId} not found`);

    await tx
      .insert(paymentUnits)
      .values({
        id: `pu_${anchorId}`,
        kind: "stripe_charge",
        stripeChargeId: anchorId,
        grossAmount: charge.grossAmount,
        feeAmount: charge.feeAmount,
        netAmount: charge.netAmount,
        currency: (charge.currency ?? "USD").toUpperCase(),
        receivedDate: charge.dateReceived,
        lifecycle: charge.disputed
          ? "disputed"
          : charge.refunded
            ? "refunded"
            : charge.amountRefunded != null && Number(charge.amountRefunded) > 0
              ? "partially_refunded"
              : "received",
      })
      .onConflictDoNothing();
  } else if (source === "quickbooks") {
    const payment = await tx
      .select({
        amount: stagedPayments.amount,
        fundingSource: stagedPayments.fundingSource,
        qbPaymentMethod: stagedPayments.qbPaymentMethod,
        qbCheckNumber: stagedPayments.qbCheckNumber,
        qbCurrency: stagedPayments.qbCurrency,
        dateReceived: stagedPayments.dateReceived,
      })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, anchorId))
      .then((rows) => rows[0]);
    if (!payment) throw new Error(`payment unit source ${anchorId} not found`);

    const kind =
      payment.fundingSource === "check"
        ? "check"
        : payment.fundingSource === "wire_ach" &&
            payment.qbPaymentMethod?.toLowerCase().includes("wire")
          ? "wire"
          : payment.fundingSource === "wire_ach"
            ? "direct_ach"
            : payment.qbCheckNumber != null ||
                payment.qbPaymentMethod?.toLowerCase().includes("check")
              ? "check"
              : "other";

    await tx
      .insert(paymentUnits)
      .values({
        id: `pu_${anchorId}`,
        kind,
        sourceStagedPaymentId: anchorId,
        grossAmount: payment.amount,
        feeAmount: null,
        netAmount: payment.amount,
        currency: (payment.qbCurrency ?? "USD").toUpperCase(),
        receivedDate: payment.dateReceived,
        lifecycle: "received",
      })
      .onConflictDoNothing();
  } else {
    const donation = await tx
      .select({
        amount: donorboxDonations.amount,
        processingFee: donorboxDonations.processingFee,
        currency: donorboxDonations.currency,
        dateReceived: donorboxDonations.dateReceived,
        stripeChargeId: donorboxDonations.stripeChargeId,
      })
      .from(donorboxDonations)
      .where(eq(donorboxDonations.id, anchorId))
      .then((rows) => rows[0]);
    if (!donation) throw new Error(`payment unit source ${anchorId} not found`);

    if (donation.stripeChargeId) {
      const stripeUnitId = await ensurePaymentUnit(
        tx,
        "stripe",
        donation.stripeChargeId,
      );
      await tx
        .update(paymentUnits)
        .set({ donorboxDonationId: anchorId })
        .where(eq(paymentUnits.id, stripeUnitId));
    } else {
      await tx
        .insert(paymentUnits)
        .values({
          id: `pu_${anchorId}`,
          kind: "other",
          donorboxDonationId: anchorId,
          grossAmount: donation.amount,
          feeAmount: donation.processingFee,
          netAmount:
            donation.amount == null || donation.processingFee == null
              ? donation.amount
              : sql`${donation.amount}::numeric - ${donation.processingFee}::numeric`,
          currency: (donation.currency ?? "USD").toUpperCase(),
          receivedDate: donation.dateReceived,
          lifecycle: "received",
        })
        .onConflictDoNothing();
    }
  }

  const unit = await tx
    .select({ id: paymentUnits.id })
    .from(paymentUnits)
    .where(
      or(
        anchorPredicate(source, anchorId),
        eq(paymentUnits.id, `pu_${anchorId}`),
      ),
    )
    .then((rows) => rows[0]?.id);
  if (!unit) throw new Error(`unable to create payment unit for ${anchorId}`);
  return unit;
}
