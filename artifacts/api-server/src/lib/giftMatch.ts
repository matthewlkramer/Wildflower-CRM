import { sql, type SQL } from "drizzle-orm";

/**
 * THE ONE gift↔payment matcher — the single source of truth for the amount band
 * and date window every reconciliation surface uses: the reconciler card list
 * (`unlinkedDonorGiftWhere` / the charge pool in cards.ts), the graph node
 * search (`fetchGiftCandidates` in reconciliationGraph.ts), the QuickBooks
 * candidate / gift-window / already-linked endpoints, and the ingest matcher
 * (`giftsInWindow` in quickbooksMatch.ts). Keeping one definition here means the
 * queue's "match vs create gift" proposal, the ready/bulk-approve hint, and the
 * approve gate can never drift apart.
 *
 * A deliberate POLICY split is layered on top of this one band — the differences
 * are parameters, never divergent copies of the math:
 *   - HUMAN-FACING PROPOSALS (cards / candidates / graph) may use the WIDENED
 *     donor-scoped band (mode c) so a gift booked under the Stripe gross still
 *     surfaces.
 *   - The ready/bulk-approve hint and the INGEST auto-apply path stay on the
 *     STRICT band (mode b) so nothing is silently tied or one-click approved
 *     outside the approve gate's own band (`amountWithinFeeBand`).
 *   - A charge anchor (known processor net) uses the KNOWN-NET band (mode a),
 *     which is gate-consistent by construction.
 */

/**
 * Reconciliation UI date window. A booked gift's date routinely trails the
 * settlement/charge date by weeks, and a resolved donor already prevents
 * cross-donor false positives, so this can be generous. Calibrated against
 * production: ±90d catches essentially every real charge↔gift match without
 * pulling in wrong-year gifts (the next real date gaps jump to 366d+).
 */
export const GIFT_MATCH_WINDOW_DAYS = 90;

/**
 * Ingest matcher window (quickbooksMatch.giftsInWindow). Deliberately STRICTER
 * than the UI window because the ingest path can auto-apply a match with no
 * human review, so it only claims gifts booked close to the payment date.
 */
export const INGEST_GIFT_WINDOW_DAYS = 60;

/**
 * Amount predicate for a 1:1 gift↔payment match anchored on a SINGLE amount (no
 * known processor net). Mirrors `amountWithinFeeBand`'s QB-only branch
 * (reconciliationGate.ts) EXACTLY — keep the two in lockstep:
 *
 *   - `donorScoped = false` → STRICT band `[anchor - 0.01, anchor * 1.10 + 1]`.
 *     This is the approve gate's band; use it for the ready/bulk-approve hint,
 *     the donor-AGNOSTIC gift-window search, and the ingest matcher. Safe
 *     cross-donor (a 1-cent floor, never a gift booked under the anchor).
 *   - `donorScoped = true`  → WIDENED band `[anchor * 0.90 - 1, anchor * 1.10 + 1]`,
 *     for HUMAN PROPOSALS ONLY, where the pool is already limited to one donor's
 *     own gifts (cross-donor false positives impossible). The mirror-fee lower
 *     bound surfaces a gift booked slightly UNDER the Stripe gross (fee-cover /
 *     rounding, e.g. a $104.00 gift behind a $104.42 charge) or one recorded net
 *     of fees. The upper bound always allows a gift booked slightly ABOVE.
 *
 * `giftAmount` / `anchorAmount` are passed as SQL so the same predicate embeds
 * in both a standalone SELECT (qualified column) and a correlated subquery
 * (aliased `g.amount`).
 */
export function giftMatchAmountBounds(
  giftAmount: SQL,
  anchorAmount: SQL,
  donorScoped: boolean,
): SQL {
  const lower = donorScoped
    ? sql`${giftAmount} >= ${anchorAmount} * 0.90 - 1`
    : sql`${giftAmount} >= ${anchorAmount} - 0.01`;
  return sql`(${lower} AND ${giftAmount} <= ${anchorAmount} * 1.10 + 1)`;
}

/**
 * Amount predicate for a match anchored on a Stripe charge, where the processor
 * NET is known. Mirrors `amountWithinFeeBand`'s net-known branch EXACTLY: the
 * gift is the same money ONLY inside `[min(net,gross) - 0.01, max(net,gross) + 0.01]`
 * — the sole legitimate gap is gross vs net, a fee apart. A gift outside this
 * window (including ABOVE the gross, which a fee can never explain) is a real
 * discrepancy. Because this window equals the gate's, a charge proposal it
 * surfaces can never be rejected at approve — use it for BOTH the charge
 * proposal pool and any charge ready hint.
 *
 * NULL handling is the CALLER's job: Postgres LEAST/GREATEST IGNORE NULLs, so a
 * NULL `netAmount` here does NOT null out the band — it silently collapses it to
 * `[gross - 0.01, gross + 0.01]` (near-exact gross only). That is the safe
 * (narrower) direction, but it is NOT the intended "known-net" semantics, so
 * callers that only want this band when the net is genuinely known must guard
 * `netAmount IS NOT NULL` themselves (see `unlinkedChargeGiftWhere` in cards.ts).
 *
 * `giftAmount` / `grossAmount` / `netAmount` are SQL for the same embed-anywhere
 * reason as `giftMatchAmountBounds`.
 */
export function giftMatchAmountBoundsKnownNet(
  giftAmount: SQL,
  grossAmount: SQL,
  netAmount: SQL,
): SQL {
  return sql`(
    ${giftAmount} >= LEAST(${netAmount}, ${grossAmount}) - 0.01
    AND ${giftAmount} <= GREATEST(${netAmount}, ${grossAmount}) + 0.01
  )`;
}
