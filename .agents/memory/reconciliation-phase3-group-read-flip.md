---
name: Phase 3 group-read flip (source_group_id → unit_group_members)
description: What the reconciliation-redesign Phase 3 flips vs. keeps legacy, why the revert path needs no flip, and a teardown bug that pollutes the shared dev DB.
---

# Phase 3 mechanism collapse — source-group read flip

**Later development (2026-07-23):** new group creation has since been retired
entirely (group/group-reconcile are 410 stubs; combining goes through
multi-match writing N counted rows, no group record), and `unit_groups` itself
is slated for retirement per `docs/adr-linear-money-model.md` §7 step 3. This
note remains as history of the source_group_id → unit_group_members flip.

Goal: flip group READS/GUARDS off legacy `staged_payments.source_group_id` +
"representative + `group_reconciled_gift_id`" dance onto first-class
`unit_group_members` (helpers in `lib/unitGroupMembership.ts`: `isGroupMember`,
`groupMemberIdsFor`), while KEEPING the legacy dual-writes until Phase 7.

## COMPLETED — reads AND writes fully flipped, column dropped

The Phase-3 partial flip is now finished: `source_group_id` is retired. See
`unit-groups-model.md` for the final state. What changed since:
- **Query-layer reads flipped too:** `reconciliation/cards.ts` (representative,
  group aggregate, `isSourceGroup`, derived `sourceGroupId`) and
  `reconciliation/bundleAnchors.ts` (eligibility = `NOT EXISTS unit_group_members`)
  now read the new table.
- **Writes no longer dual-write:** `actions.ts` group/ungroup write ONLY
  `unit_groups`/`unit_group_members`; the group id is a fresh `ug_<newId()>`
  (no longer deterministic `ug_<source_group_id>`).
- **Column gone:** dropped from schema + migration `0104`. The
  `group_reconciled_gift_id` reconciliation-linkage pointer is a SEPARATE concern
  and stays (revert still keys off it).

**Historical note (mixed-read era):** while some reads were flipped and others
legacy, each read surface sourced membership from EXACTLY ONE representation, and
dual-write + parity gates kept them equivalent. That constraint no longer matters
now that there is one store.

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
