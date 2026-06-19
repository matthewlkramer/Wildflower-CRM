---
name: Pledge paid_amount includes archived payments
description: deriveOppFields sums ALL pledge payments incl archived; archiving a payment won't fix a wrong cash_in — hard-delete to correct.
---

`applyDerivedOppFields` / `deriveOppFields` (artifacts/api-server/src/lib/pledgeStage.ts)
compute a pledge's `paid_amount` as `SUM(gifts_and_payments.amount)` over all rows
with `payment_on_pledge_id = <pledge>` — with **no `archived_at` filter**. Archived
pledge payments STILL count toward fulfillment.

**Why it matters:** to correct a pledge that wrongly derives `status='cash_in'`
because a not-yet-collected installment was booked as a received payment, you must
**hard-delete** that payment (clear its RESTRICT children first — `gift_allocations`,
`staged_payment_splits`; the other gift FKs are SET NULL). Archiving it does nothing:
the SUM still includes it, so the pledge stays `cash_in`. (First hit fixing the
William Penn FY27 $254,750 premature installment.)

**How to apply:** any prod data fix that removes a bogus/premature pledge payment is
a DELETE, not an archive. Re-derive the pledge afterward — a raw SQL delete does not
re-run the server-side derivation (status is persisted). Mirror deriveOppFields:
fully paid (paid>=awarded>0) -> status `cash_in`, win_prob 1.0, advance a
`written_commitment` stage to `cash_in`; else `written_commitment` -> status
`pledge`, win_prob 0.9. Lock the target gift `FOR UPDATE` before deleting (concurrent
FK-child inserts otherwise race the guard — same pattern as the entity-merge lock).

**Latent bug, intentionally not fixed:** archived gifts arguably should NOT count
toward fulfillment. Changing the SUM to exclude `archived_at` would shift many
pledges' derived status at once, so treat it as a known constraint, not a quick fix.
