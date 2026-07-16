import type { NewGiftOrPayment } from "@workspace/db/schema";

/**
 * Pure builder for the gifts_and_payments values minted from a Stripe staged
 * charge — the Stripe analogue of buildGiftValuesFromStaged (QuickBooks). Shared
 * by the manual "approve → create gift" route so the minted row is identical
 * regardless of entry point.
 *
 * Mints the gift HEADER only (no gift_allocations) — a fundraiser allocates
 * afterward, same as the QuickBooks flow. Donors are credited the GROSS charge
 * amount (processor fees are not netted out of the donor's gift). The Donor XOR
 * is the caller's responsibility (validate via validateGiftInvariants before
 * inserting).
 */
export interface StripeStagedGiftSource {
  chargeId: string;
  /** GROSS charge amount, major units (string). */
  grossAmount: string | null;
  /** Processor (Stripe) fee withheld from this charge, major units (string). */
  feeAmount: string | null;
  dateReceived: string | null;
  payerName: string | null;
  description: string | null;
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
  /** Conduit the donor gave through (Stripe / DAF), propagated when present. */
  matchedPaymentIntermediaryId: string | null;
}

export function buildGiftValuesFromStripeCharge(
  giftId: string,
  staged: StripeStagedGiftSource,
  ownerUserId: string | null,
): NewGiftOrPayment {
  const name = staged.payerName ?? staged.description ?? "Stripe charge";
  return {
    id: giftId,
    name,
    amount: staged.grossAmount,
    // Donor is credited GROSS; the processor fee is derived at read time from the
    // gift's linked Stripe charge (derivedProcessorFee), not stored on the header.
    dateReceived: staged.dateReceived,
    organizationId: staged.organizationId,
    individualGiverPersonId: staged.individualGiverPersonId,
    householdId: staged.householdId,
    paymentIntermediaryId: staged.matchedPaymentIntermediaryId,
    details: `Imported from Stripe (charge ${staged.chargeId}).`,
    ownerUserId,
    // This gift is BORN from a Stripe charge; the provenance is the ledger row
    // booked by the caller (evidence_source='stripe', created_the_gift=true).
    // finalAmountStripeChargeId is @deprecated and never written — the ledger
    // is the sole source. originalHumanCrmAmount stays null (there was never a
    // human-entered figure to snapshot).
    finalAmountSource: "stripe",
    originalHumanCrmAmount: null,
  };
}
