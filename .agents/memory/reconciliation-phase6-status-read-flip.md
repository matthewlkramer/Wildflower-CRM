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

## Write-flip DONE — legacy columns are now a pure write-only mirror
The confirm/revert optimistic lock moved off `stripe_payouts.qb_reconciliation_status`
onto a guarded `settlement_links` UPDATE (`transitionSettlementLink`, guarded by
`lifecycle` + `conflict_gift_id` presence), and the last legacy POINTER reader —
`cards.ts` `charge_unit` lateral — was flipped to
`settlement_links.deposit_staged_payment_id`. The conflict-pointer coalesce caveat was
resolved deliberately (the link's coalesce IS the ratified deriver semantics; prod had
ZERO divergent rows, dev had 9 conflict_approved rows that now resolve via the conflict
pointer = a fix, not a regression). No confirm/revert/queue LOGIC reads the 4 legacy
columns anymore.

**Remaining readers = the parity script + the `routes/stripe.ts` response scrub ONLY.**
The legacy-column DROP task's read-side precondition is therefore satisfied; the
dual-write mirror is still RETAINED for parity + rollback until that separate
human-gated DROP. Carry the prod evidence (zero divergent pointer rows) into the DROP
task as the equivalence proof.
