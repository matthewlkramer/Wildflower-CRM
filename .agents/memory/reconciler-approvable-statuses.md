---
name: Reconciler approvable statuses & the three staged gift-link columns
description: Which staged_payments statuses the unified reconciler may approve, and the complete set of gift-linkage columns any mint/double-count guard must check.
---

# Reconciler approvable statuses & the three staged gift-link columns

## Approvable = pending OR approved (not just pending)

The unified complete-match reconciler approve route + its consistency gate treat
a staged_payments row as **open for reconciliation** when its status is `pending`
**or** `approved`. Terminal/blocked = `reconciled` / `excluded`.

**Why:** the OLD `/staged-payments` flow leaves rows in `approved` (moved out of
`pending` but never `reconciled`). Those rows are still legitimately reconcilable
in the unified reconciler. Hard-blocking everything except `pending` made
approving them throw a 409 ("already approved / no longer pending") that surfaced
as a destructive red toast — a real user-reported bug.

**How to apply:** never compare `status === 'pending'` in approve/gate code; use
the shared `APPROVABLE_STAGED_STATUSES` / `isStagedApprovable()` from
`reconciliationGate.ts`, and gate every guarded UPDATE WHERE with
`inArray(status, APPROVABLE_STAGED_STATUSES)`. The group-reconcile endpoint
(`routes/quickbooks/matching.ts`) was the last holdout still hard-coding
`status === 'pending'`; it now uses the shared `isStagedApprovable` too, so a
grouped card whose representative is `pending` but whose member is a stranded
`approved` row no longer 409s the whole group with `not_pending`.

## An `approved` row with ALL THREE gift links NULL is a real, still-open state

Don't assume `approved` ⇒ "has a gift". A row can sit at `status='approved'` with
`matched_gift_id` / `created_gift_id` / `group_reconciled_gift_id` all NULL.

**Why:** the sync worker auto-matches a row to a gift (`auto_applied=t`,
`match_method=name_amount_date`, `match_confirmed_at` stamped) → `approved`. If
that gift is later hard-deleted (gift merge / QuickBooks revert), the gift-link
FKs are `onDelete:'set null'`, so the pointer clears but the status stays
`approved` and the match metadata ghost remains. The reconcilable test is
therefore "approvable status AND no gift link", never status alone.

**Deeper gap (open follow-up):** delete/merge/revert nulls the FK but does NOT
reset `approved → pending`, which is what strands these rows. A more complete fix
would reset status when clearing the last gift link; the reconciler tolerating
the stranded state is the conservative, non-destructive workaround.

## staged_payments has THREE gift-linkage columns — guard ALL of them

A staged row can point at an existing gift via **three** different columns:
`matchedGiftId` (human/auto match), `createdGiftId` (it minted the gift), and
`groupReconciledGiftId` (grouped QB reconciliation — a non-representative member
of a multi-row group ties to the group's gift).

**Why:** the create_gift / mint double-count guard originally checked only
`matchedGiftId` + `createdGiftId`. An `approved` grouped-member row carrying only
`groupReconciledGiftId` slipped through and could mint a SECOND gift for money
already reconciled — exactly the double-count the guard exists to prevent.

**How to apply:** any "already has a gift, don't mint" guard (both the fast
non-locking preflight AND the locked in-tx recheck) must reject when ANY of the
three is non-null (`gift_already_linked`). The graph proposer already COALESCEs
all three as the resolved gift, and the link path's `NOT EXISTS` conflict guard
already recognizes all three — so the mint guard is the one place that tends to
drift out of sync. If a fourth gift-link column is ever added, update all three
sites in lockstep.
