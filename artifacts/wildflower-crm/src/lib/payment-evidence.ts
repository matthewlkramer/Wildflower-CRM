export type AccountingEvidenceReference = {
  stagedPaymentId?: string | null;
};

/**
 * Bank-sourced payments count as payment evidence before QuickBooks posting.
 * The imported staged-payment ID is the evidence that the accounting record
 * exists; keep this label derived instead of storing a second status.
 */
export function accountingPostingLabel(
  record: AccountingEvidenceReference,
): "Not Yet Posted" | null {
  return record.stagedPaymentId ? null : "Not Yet Posted";
}
