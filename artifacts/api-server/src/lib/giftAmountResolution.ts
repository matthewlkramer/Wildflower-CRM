import { sql, type SQL } from "drizzle-orm";
import { deriveGiftQbTieLiveExpr } from "./giftQbTie";

/**
 * A gift's amount is "unresolved" when it does not tie to accounting. This is
 * derived live from the QB-tie expression ('amount_mismatch' = amount disagrees
 * with the matched evidence, 'missing' = no match found). Off-books gifts are
 * always 'exempt', so they are excluded naturally.
 *
 * This module is the single swap-point for the unresolved-gift definition:
 * change ONLY this predicate + list and every caller (the pre-close checklist,
 * the amount-mismatch resolution worklist) follows in one place. Over- vs
 * under-payment DIRECTION is computed on the fly in the worklist layer
 * (linkAmount vs gift.amount), never persisted as a status value.
 */
export const UNRESOLVED_TIE_STATUSES = ["amount_mismatch", "missing"] as const;

/** Drizzle WHERE condition selecting gifts whose amount is unresolved. */
export function unresolvedGiftAmountCondition(): SQL {
  const statuses = ([...UNRESOLVED_TIE_STATUSES] as string[]).map(
    (v) => sql`${v}`,
  );
  return sql<boolean>`(${deriveGiftQbTieLiveExpr()}) IN (${sql.join(statuses, sql`, `)})`;
}
