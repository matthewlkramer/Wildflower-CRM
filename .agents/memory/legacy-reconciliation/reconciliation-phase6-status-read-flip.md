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

**Why the inverse is lossless:** the authoritative writers
(`proposeSettlementLink` / `confirmSettlementLink`) only ever produce the 4 live
states and set/clear the conflict pointer atomically with lifecycle, so the legacy
`confirmed_keep/excluded/replace` sub-states can no longer occur. Prod confirmed this
(distribution = only the 4 live values). Because of that, the 3 dead revert branches
(`confirmed_excluded/keep/replace`) in `stripeConfirm.ts` were deleted as unreachable.

**Legacy columns are GONE.** The dual-write to `stripe_payouts.qb_reconciliation_status`
(+ pointer cols) was removed and the columns physically dropped (migration 0093);
`settlement_links` is the sole store.

## Write-flip DONE — then the legacy columns were dropped
The confirm/revert optimistic lock moved off `stripe_payouts.qb_reconciliation_status`
onto a guarded `settlement_links` UPDATE (`transitionSettlementLink`, guarded by
`lifecycle` + `conflict_gift_id` presence), and the last legacy POINTER reader —
`cards.ts` `charge_unit` lateral — was flipped to
`settlement_links.deposit_staged_payment_id`. The conflict-pointer coalesce caveat was
resolved deliberately (the link's coalesce IS the ratified deriver semantics; prod had
ZERO divergent rows, dev had 9 conflict_approved rows that now resolve via the conflict
pointer = a fix, not a regression). No confirm/revert/queue LOGIC reads the 4 legacy
columns anymore.

**DROP complete.** No logic read the 4 legacy columns; the only remaining touch-points
(the parity script + the `routes/stripe.ts` response scrub) were removed with the drop.
The 7 columns + their index are dropped from the schema and by migration 0093, whose
prod-safe ordering is: Publish FIRST so the live build stops writing them, THEN drop
both DBs back-to-back (see that RUNBOOK). `qb_supersede_status` is a different concern,
kept + still scrubbed.
