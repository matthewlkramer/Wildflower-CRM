---
name: Stripe charge evidence must carry matchedGiftId
description: Tying a stripe_staged_charges row to an existing gift requires the row-local matchedGiftId, not just status='reconciled'.
---

Any code path that marks a `stripe_staged_charges` row `status='reconciled'` to tie
it to an EXISTING gift as reconciliation evidence MUST also set its row-local
`matchedGiftId = giftId` (and clear `createdGiftId`). Setting only
`status='reconciled'` is silently broken.

**Why:** the Stripe charge list/detail resolves its linked gift via
`COALESCE(matchedGiftId, createdGiftId)`, and the revert flow treats a `reconciled`
charge with NEITHER `matchedGiftId` nor `createdGiftId` as `not_revertible`. The
gift-side `gifts_and_payments.final_amount_stripe_charge_id` pointer is NOT consulted
by those paths, so without `matchedGiftId` the charge becomes terminal-but-orphaned
(invisible in resolution, un-revertible). This regression was introduced once in the
unified reconciler approve route and caught in review.

**How to apply:** mirror the QB `staged_payments` evidence update / the Stripe confirm
field set — `status:'reconciled'`, `matchedGiftId:giftId`, `createdGiftId:null`,
`matchStatus:'matched'`, plus match/approve user + timestamps. Note the bijective
integrity: `stripe_staged_charges.matched_gift_id` has a partial-unique (one gift per
charge) that complements `gifts_and_payments.final_amount_stripe_charge_id`'s unique
(one charge per gift); a write-skew on either surfaces as 23505 → map to 409.
