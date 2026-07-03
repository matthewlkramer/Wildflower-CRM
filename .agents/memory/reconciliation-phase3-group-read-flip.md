---
name: Phase 3 group-read flip (source_group_id → unit_group_members)
description: What the reconciliation-redesign Phase 3 flips vs. keeps legacy, why the revert path needs no flip, and a teardown bug that pollutes the shared dev DB.
---

# Phase 3 mechanism collapse — source-group read flip

Goal: flip group READS/GUARDS off legacy `staged_payments.source_group_id` +
"representative + `group_reconciled_gift_id`" dance onto first-class
`unit_group_members` (helpers in `lib/unitGroupMembership.ts`: `isGroupMember`,
`groupMemberIdsFor`), while KEEPING the legacy dual-writes until Phase 7.

## What flips in Phase 3 vs. what stays legacy

- **Flip now (guards + mutation-adjacent reads):** the group-expansion / group
  guard reads in `quickbooks/matching.ts`, `quickbooks/actions.ts` (the resolve
  guard, NOT the group/ungroup writes), `reconciliation/approve.ts` (group mint
  expansion → `groupMemberIdsFor`, rep = `memberIds[0]`), `reconciliationGraph.ts`.
- **Stay legacy through Phase 3 (query-layer read projections):**
  `reconciliation/cards.ts` (representative filter + group aggregate lateral +
  `isSourceGroup`/`sourceGroupId` output) and `reconciliation/bundleAnchors.ts`
  (`s.source_group_id IS NULL` eligibility). Deferred to Phase 6/7 with the
  two-report UI collapse — double-count-adjacent, and safe to leave because
  dual-write parity makes the legacy read equivalent.
- **Writes stay (dual-write until Phase 7):** `actions.ts` group/ungroup write
  BOTH `source_group_id` AND `unit_groups`/`unit_group_members` (deterministic
  `ug_<sourceGroupId>`), plus the approve mint still writes the representative +
  `group_reconciled_gift_id` pointer dance.

**Why mixed reads are safe:** each read surface must source group membership from
EXACTLY ONE representation (never sum both). Dual-write + the parity gates
(`parity-group-readflip.ts`, `parity-unit-groups.ts`, both prod-gated green) keep
the two representations equivalent, so some-flipped/some-legacy is correct.

## Revert path needs NO flip (it is a Phase-3 no-op)

`quickbooks/shared.ts` `revertOneStagedPayment` identifies a reconciled group and
its representative from the RECONCILIATION-LINKAGE pointers
(`group_reconciled_gift_id`, and rep = the member whose `matched_gift_id` == that
gift), NOT from `source_group_id`. Those pointers are dual-written through Phase 3
and only removed in Phase 7, so the revert path stays correct as-is. There is no
`source_group_id` read there to flip.

## Pre-existing reconciliation-approve teardown bug (pollutes SHARED dev DB)

Stripe-evidence `payment_applications` rows anchor on `stripe_charge_id` + `gift_id`
with `payment_id` NULL. The approve integration-test teardown clears PA rows by
`payment_id` only, so it never clears the stripe-evidence rows; the subsequent
`DELETE FROM stripe_staged_charges` then trips
`payment_applications_stripe_evidence_chk` via `ON DELETE SET NULL`, the teardown
aborts, and `reconapv_*` fixtures leak into the shared dev DB every run.
**Fix shape:** clear PA rows by anchor (`gift_id` / `stripe_charge_id`), not just
`payment_id`, BEFORE deleting charges/payouts/gifts. Not caused by the group flip.

## Two pre-existing Stripe-GROSS stamping failures (possible financial regression)

Two reconciliation-approve tests fail independently of the group flip: a
Stripe-matched gift is being stamped to the Stripe NET (e.g. 98.50) or left at the
original above-gross amount (105.00) instead of the Stripe GROSS (100.00) the
ratified "Stripe GROSS wins" design requires (GROSS is the donor's gift; NET is
only the fee-band floor). Prove-pre-existing trick: the `/split` route test also
drifts (`split_too_small` vs `validation_error`) with no group code involved.
