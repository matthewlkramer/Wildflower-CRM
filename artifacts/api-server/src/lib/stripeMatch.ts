import { scoreStagedPayment, type ScoredMatch } from "./quickbooksMatch";

/**
 * Thin adapter that maps a Stripe charge's donor-identifying facts onto the
 * shared scored matcher (scoreStagedPayment). Stripe and QuickBooks resolve
 * donors against the same CRM tables and existing-gift window, so the scoring
 * logic is shared verbatim — only the field mapping differs:
 *
 *   payerName       ← charge.billing_details.name
 *   payerEmail      ← charge.billing_details.email / receipt_email
 *   rawReference    ← charge.description   (donor name often lives here)
 *   lineDescription ← charge statement descriptor
 *   amount          ← GROSS charge amount (donors are credited gross)
 *
 * The matcher is told this row is a Stripe charge (`evidenceKind: "charge"`), so
 * its existing-gift window excludes only gifts already owned by ANOTHER Stripe
 * charge — a gift a QuickBooks staged payment already booked stays a valid
 * reconcile target (Stripe and QB are parallel evidence for the same money,
 * deduped by the book-once ledger, not by hiding the gift). Pure of write
 * side-effects — never mints a gift.
 */
export interface StripeMatchInput {
  payerName: string | null;
  payerEmail: string | null;
  description: string | null;
  statementDescriptor: string | null;
  /** GROSS charge amount, major units (string), e.g. "100.00". */
  grossAmount: string | null;
  dateReceived: string | null;
}

export function scoreStripeCharge(
  input: StripeMatchInput,
): Promise<ScoredMatch> {
  return scoreStagedPayment({
    payerName: input.payerName,
    payerEmail: input.payerEmail,
    rawReference: input.description,
    lineDescription: input.statementDescriptor,
    amount: input.grossAmount,
    dateReceived: input.dateReceived,
    evidenceKind: "charge",
  });
}
