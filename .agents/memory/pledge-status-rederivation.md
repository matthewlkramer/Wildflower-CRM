---
name: Pledge paid_amount derivation & re-derivation
description: pledge paid_amount SUM EXCLUDES archived payments; out-of-band (raw SQL) changes don't re-run server derivation — re-derive by mirroring deriveOppFields.
---

`applyDerivedOppFields` / `deriveOppFields` (artifacts/api-server/src/lib/pledgeStage.ts)
compute a pledge's `paid_amount` as `SUM(gifts_and_payments.amount)` over rows with
`payment_on_pledge_id = <pledge>` **AND `archived_at IS NULL`**. Archived payments do
NOT count toward fulfillment — consistent with the global archived-gift exclusion
(see archive-soft-delete-boundaries.md).

**Why:** archive is a strict soft-delete here, so an archived payment is logically
gone and must not keep a pledge derived as `cash_in`. (Earlier the SUM had no
archived filter — that gap is closed; do not reintroduce it.)

**How to apply — correcting a wrongly-derived `status='cash_in'`:** a pledge derives
`cash_in` when `paid >= awarded > 0`. If a not-yet-collected installment was wrongly
booked as received, remove it from the SUM (archiving it is now sufficient since
archived rows are excluded; or hard-delete it, clearing RESTRICT children
`gift_allocations` / `staged_payment_splits` first — the other gift FKs SET NULL),
THEN re-derive. An out-of-band change (raw SQL, or anything that doesn't go through
`applyDerivedOppFields`) does NOT re-run the server-side derivation — status is
persisted — so mirror `deriveOppFields` by hand: fully paid (`paid >= awarded > 0`)
-> status `cash_in`, win_prob 1.0, advance a `written_commitment` stage to `cash_in`;
else `written_commitment` -> status `pledge`, win_prob 0.9. Lock the target gift
`FOR UPDATE` before deleting (concurrent FK-child inserts otherwise race the guard —
same pattern as the entity-merge lock). (First hit fixing the William Penn FY27
$254,750 premature installment.)
