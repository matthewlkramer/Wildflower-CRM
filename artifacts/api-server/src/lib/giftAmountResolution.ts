import { inArray, type SQL } from "drizzle-orm";
import { giftsAndPayments } from "@workspace/db/schema";

/**
 * A gift's amount is "unresolved" when it does not tie to accounting. This is
 * read from the `quickbooks_tie_status` column ('amount_mismatch' = amount
 * disagrees with the matched evidence, 'missing' = no match found). Off-books
 * gifts are already 'exempt', so they are excluded naturally.
 *
 * `quickbooks_tie_status` is still actively read/written (its
 * exempt|reconciled|partial|unreconciled rename is a later reconciliation phase,
 * out of scope here). This module is the single swap-point if it is ever renamed:
 * change ONLY this predicate + list and every caller (the pre-close checklist,
 * the amount-mismatch resolution worklist) follows in one place. Over- vs
 * under-payment DIRECTION is computed on the fly in the worklist layer
 * (linkAmount vs gift.amount), never persisted as a status value.
 */
export const UNRESOLVED_TIE_STATUSES = ["amount_mismatch", "missing"] as const;

/** Drizzle WHERE condition selecting gifts whose amount is unresolved. */
export function unresolvedGiftAmountCondition(): SQL {
  return inArray(giftsAndPayments.quickbooksTieStatus, [...UNRESOLVED_TIE_STATUSES]);
}
