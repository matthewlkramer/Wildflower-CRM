import { inArray, type SQL } from "drizzle-orm";
import { giftsAndPayments } from "@workspace/db/schema";

/**
 * A gift's amount is "unresolved" when it does not tie to accounting. Today this
 * is read from the TRANSITIONAL quickbooks_tie_status column ('amount_mismatch' =
 * amount disagrees with the matched QB txn, 'missing' = no QB match found).
 * Off-books gifts are already 'exempt', so they are excluded naturally.
 *
 * P3 introduces a derived reconciliation status (exempt|unreconciled|partial|
 * reconciled|overpaid) and P6 retires quickbooks_tie_status entirely. When that
 * lands, change ONLY this predicate + list and every caller (the pre-close
 * checklist, the resolution worklist) follows in one place.
 */
export const UNRESOLVED_TIE_STATUSES = ["amount_mismatch", "missing"] as const;

/** Drizzle WHERE condition selecting gifts whose amount is unresolved. */
export function unresolvedGiftAmountCondition(): SQL {
  return inArray(giftsAndPayments.quickbooksTieStatus, [...UNRESOLVED_TIE_STATUSES]);
}
