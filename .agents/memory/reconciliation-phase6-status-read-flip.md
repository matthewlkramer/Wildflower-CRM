---
name: Reconciliation Phase-6 status read-flip
description: The last readers of the legacy payout status mirror now derive from settlement_links; what still blocks dropping the legacy columns.
---

# Phase-6 read-flip: payout status mirror → settlement_links

The last readers of `stripe_payouts.qb_reconciliation_status` (the payout ↔ QB-deposit
settlement status) were flipped onto the first-class `settlement_links` table. Two
shared helpers in `settlementLink.ts` are the ONLY sanctioned way to read that status now:

- `payoutStatusLabelSql` — a drizzle sql CASE over a joined `settlement_links` row
  (**hardcodes the alias `sl`**; null → `unmatched`). Used by SQL-expression readers
  (`bundleAnchors.ts`, `cards.ts` stripe-evidence status).
- `payoutStatusFromLink(link|null)` — pure inverse off a loaded row (null→unmatched,
  confirmed→confirmed_reconciled, proposed+conflictGiftId→conflict_approved,
  proposed→proposed). Used by `stripeConfirm.ts` confirm/revert gate + pointers.

**Why the inverse is lossless:** the authoritative writer (`reverseSettlementLink`)
only ever produces the 4 live states and sets/clears the conflict pointer atomically
with lifecycle, so the legacy `confirmed_keep/excluded/replace` sub-states can no
longer occur. Prod confirmed this (distribution = only the 4 live values; parity gate
PASS). Because of that, the 3 dead revert branches (`confirmed_excluded/keep/replace`)
in `stripeConfirm.ts` were deleted as unreachable.

**Dual-writes are intentionally RETAINED** — every state transition still writes BOTH
the legacy `stripe_payouts.qb_reconciliation_status` (+ pointer cols) AND
`settlement_links`. The read-flip ships in ONE Publish (no schema push, no data
migration). Dropping the legacy columns is a separate LATER gated task.

## Prerequisite before dropping the legacy columns
`payoutStatusFromLink` handles the *status*, but the legacy POINTER columns still have
one live functional reader: **`cards.ts` `charge_unit` lateral** joins on
`stripePayouts.matchedQbStagedPaymentId OR proposedQbStagedPaymentId`. Harmless while
dual-writes keep pointers lockstep, but it MUST be flipped before the column DROP.
**Caveat when flipping it:** the settlement link's `deposit_staged_payment_id`
coalesces the *conflict* pointer first for `conflict_approved`, whereas this lateral
ignores the conflict pointer — flip it deliberately, not mechanically, or
conflict_approved rows will resolve to a different staged payment.

**How to apply:** treat "flip cards.ts charge_unit lateral (with the conflict-pointer
coalesce caveat)" as an explicit precondition in the legacy-column DROP task; only then
is it safe to remove `qb_reconciliation_status` + the proposed/matched/qb_conflict
pointer columns.
