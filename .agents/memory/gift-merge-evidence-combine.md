---
name: gift merge evidence combine
description: gift merge now absorbs each loser's reconciled payment evidence onto the survivor (instead of 409-blocking) then archives losers; the collision cases that still 409; and the archived-participant idempotency guard.
---

# Gift merge = ledger-aware combine

`POST /gifts-and-payments/merge` used to hard-BLOCK (409 `quickbooks_linked`)
whenever any loser carried QB/Stripe/Donorbox/ledger evidence. Now it ABSORBS
that evidence onto the survivor and archives the losers.

The absorb (helper `absorbGiftEvidenceIntoSurvivor`, `lib/giftCombine.ts`)
reads all evidence surfaces FIRST, detects an unrepresentable collision, and on
collision writes NOTHING (the tx commits a no-op and the route returns 409
`reconciled_evidence_conflict` with a `conflict` kind). Otherwise it re-homes:
the cash ledger (`payment_applications`, `link_role='counted'` only, grouped by
anchor; same-anchor rows consolidate to one keeper with SUMmed `amount_applied`,
never summing across link_role/anchor), the QB staged pointers (1 payment → clean
direct match on survivor; ≥2 → GROUP: all `group_reconciled_gift_id`=survivor +
one representative `matched_gift_id`=survivor, matched/created nulled first so the
partial-uniques are free), the single Stripe/Donorbox pointer, and
`gift_evidence_links` (dedupe on the (gift,kind,id) UNIQUE).

## Still 409 (unrepresentable — single-valued targets)
- `split_link`: a loser wired into a `staged_payment_splits` row, OR a survivor
  split coexisting with absorbed group/direct QB evidence (split precedence reads
  ONE sub-amount, can't represent a summed group).
- `stripe_charge` / `donorbox_donation`: 2+ distinct charges/donations would have
  to point at one gift, but matched/created pointers are single-valued.

## Idempotency guard (critical)
Losers are ARCHIVED, not deleted, so they PERSIST. The merge tx MUST reject any
participant (primary OR loser) whose `archived_at` is set → 409 `archived_gift`.
**Why:** without it a replay (double-click/retry) re-sums the still-present loser
`amount` onto the already-merged survivor, and an archived reconciliation-derived
coarse-QB gift (archived precisely so its money never re-enters totals) could be
resurrected into a live survivor. The FOR UPDATE lock + this guard also close the
concurrent double-submit race.

**How to apply:** any future edit to the merge route must keep the
archived-participant rejection and must not reintroduce a
COALESCE(matched,created,groupReconciled)+ledger double-read on one surface.
Post-tx runs `applyDerivedOppFieldsMany(...pledges)` +
`applyGiftQbTieMany(primary, ...losers)` (tie on archived losers benignly
derives `missing`). This is the T002/Phase-3 "ledger-aware combine (WS3)" piece;
it ships via Publish (no mid-phase prod-SQL gate).
