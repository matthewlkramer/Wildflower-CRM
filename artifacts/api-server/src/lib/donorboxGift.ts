import type { NewGiftOrPayment } from "@workspace/db/schema";

/**
 * Pure builder for the gifts_and_payments values minted from a non-Stripe
 * Donorbox donation (PayPal/ACH new money). Mirrors buildGiftValuesFromStaged
 * (QuickBooks): mints the gift HEADER only (no gift_allocations) — a fundraiser
 * allocates afterward. The donor XOR is the caller's responsibility (validate
 * via validateGiftInvariants before inserting).
 *
 * Deliberately a PLAIN CRM gift: no finalAmountSource / finalAmount* provenance
 * is stamped, so the gift's QuickBooks tie derives to `missing` (on-books, no QB
 * evidence) and surfaces in the reconciliation worklist — Donorbox is not a
 * QuickBooks/Stripe money source, so the money still needs to be tied out.
 */
export interface DonorboxGiftSource {
  id: string;
  donationType: string | null;
  amount: string | null;
  dateReceived: string | null;
  donorName: string | null;
  campaignName: string | null;
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
  /** Conduit the donor gave through (Donorbox/PayPal), propagated onto the gift. */
  matchedPaymentIntermediaryId: string | null;
}

export function buildGiftValuesFromDonorbox(
  giftId: string,
  donation: DonorboxGiftSource,
  ownerUserId: string | null,
): NewGiftOrPayment {
  const name =
    donation.donorName ?? donation.campaignName ?? "Donorbox donation";
  return {
    id: giftId,
    name,
    amount: donation.amount,
    dateReceived: donation.dateReceived,
    organizationId: donation.organizationId,
    individualGiverPersonId: donation.individualGiverPersonId,
    householdId: donation.householdId,
    paymentIntermediaryId: donation.matchedPaymentIntermediaryId,
    details: `Imported from Donorbox (${donation.donationType ?? "donation"} #${donation.id}).`,
    ownerUserId,
  };
}
