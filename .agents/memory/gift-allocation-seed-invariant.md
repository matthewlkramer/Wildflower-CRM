---
name: Gift must always have >=1 allocation
description: Every minted gift seeds a starter gift_allocations row; guard is app-level by decision, plus an FK-safety gotcha on grant_year.
---

# Every gift must have at least one allocation

A `gifts_and_payments` header is scope-less on its own — ALL money scope (fund
entity, fiscal year, sub-amount, restriction axes, region, school) lives on child
`gift_allocations` rows, and revenue coding is derived from them. Historically
several mint paths created a header-only gift and relied on a follow-up allocation
edit that sometimes never happened, leaving orphan gifts (needed a one-off prod
backfill to repair).

**Rule:** every gift-creation path must seed at least one allocation IN THE SAME
transaction. Shared helper `artifacts/api-server/src/lib/giftAllocationSeed.ts`:
`seedInitialGiftAllocation` (full-amount starter line) + `assertGiftHasAllocations`
(backstop, throws → rolls back). There are MANY mint sites — grep
`insert(giftsAndPayments)` before assuming you've found them all. Known paths:
manual POST, Stripe reconcile, QuickBooks create-gift, Donorbox, reconciliation
bundle commit, mintGiftInTx's plain-create/grouped-no-split branch, and the QB
split/remainder mint in `quickbooks/matching.ts`. Two auto-create paths in
`quickbooksSync.ts` already seed their own allocation; the gift→pledge split
re-points existing allocations (not orphaning).

**Gotcha — QB splits use a different table:** `staged_payment_splits` rows are QB
cash-application LINK records, NOT `gift_allocations`. A mint that writes only
split links still leaves the gift scope-less (this is exactly the bug a code
review caught in matching.ts's remainder gift).

**Gotcha — opp branch can copy zero:** `mintGiftInTx` copies the pledge's
allocations when an opp is present, but a pledge with zero allocations yields zero
copied rows and would trip the assertion. It has a safety net: re-count and seed a
default before asserting.

**Why app-level, not a DB trigger:** prod invariant #7 — schema ships via Publish,
data changes are human-applied SQL; the agent can't add a trigger to prod casually.
So the guard is an in-tx assertion + unit test. A true DB-level constraint is a
deliberate future follow-up (reviewed migration), not an oversight.

**FK-safety gotcha:** `gift_allocations.grant_year` is a RESTRICT FK to
`fiscal_years.id`. The seed derives the FY slug from the gift date but only SETS it
after confirming that `fiscal_years` row exists — otherwise a missing FY row would
abort the whole mint. A null grant_year is acceptable; a dangling FK is not.

**How to apply:** when adding any new gift-minting code path, call
`seedInitialGiftAllocation` + `assertGiftHasAllocations` inside the insert tx.
Thread `entityId` (from a staged/attributed row) and `countsTowardGoal` (e.g. from
`isGovernmentReimbursement`) when the source knows them.
