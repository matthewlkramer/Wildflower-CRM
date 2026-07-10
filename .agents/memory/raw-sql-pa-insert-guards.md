---
name: Raw-SQL payment_applications insert guards
description: Hand-written data-migration PA inserts must guard on state, not row existence, to survive the authoring→apply drift window.
---

Rule: a raw-SQL `INSERT INTO payment_applications` in a data-migration file must
be guarded on the staged/charge row's `matched_gift_id = '<intended gift>'`, not
merely on row EXISTENCE.

**Why:** the file bypasses the app's book-once service-layer guard. Between file
authoring and human prod apply, a reviewer or the sync worker can match that
same payment to a DIFFERENT gift; the state-guarded stamp UPDATE then no-ops,
but an existence-only PA insert still fires — creating a second `counted`
ledger row for the same money across two gifts (the partial-unique ON CONFLICT
only covers same payment+gift, so it does not catch this).

**How to apply:** in any hand-authored migration that both stamps a
staged/charge match AND inserts its PA ledger row, make the PA insert's WHERE
require the staged/charge row to already point at the intended gift (the stamp
UPDATE earlier in the same file satisfies it on first apply; drifted rows no-op
both statements). Same pattern for QB `payment_id` and Stripe
`stripe_charge_id` legs.
