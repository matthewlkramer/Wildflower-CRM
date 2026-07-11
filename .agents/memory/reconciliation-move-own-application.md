---
name: Own-application retarget move
description: Re-targeting a QB payment off the wrong gift via moveOwnApplication; movability rule and failed-charge orphan landing.
---

# Own-application retarget move (moveOwnApplication)

The approve route's `link_existing_gift` outcome supports a `moveOwnApplication`
flag for the case where the ANCHOR payment itself already holds a COUNTED
cash-application to a DIFFERENT gift (sync worker auto-matched the wrong one of
two identical donations). Without it the book-once guard dead-ends 409.

**Rules:**

- **Movable** only when the payment's PA-ledger gift (quickbooks + counted,
  excluding the target gift) AGREES with `staged.matchedGiftId`, and the row has
  no `createdGiftId` and no `groupReconciledGiftId`. A minted or group link is
  NOT movable one-at-a-time; split rows carry no matchedGiftId so they fail the
  agreement check. Non-movable → the old hard 409 `payment_already_applied`.
- Movable without the flag → RECOVERABLE gate issue `payment_already_applied`
  (consistency_gate 409) carrying `currentAppliedGift` + `targetGiftId`; the
  workbench retarget dialog confirms and re-POSTs with the flag.
- Commit unwinds the payment's OWN old application FIRST (mirror-inverse of
  incumbent displacement): remove PA rows → pointer-safe
  `unstampGiftFinalAmount(quickbooks)` → allocation adjust + old-pledge
  re-derive only if restored → audit on the old gift. Lock the OLD gift row too.
- After commit `applyGiftQbTieMany(target, movedFrom)` recomputes tie status on
  BOTH sides — the old gift silently loses its only QB evidence otherwise.

**Failed Stripe charge orphan:** when `switchStripeSource` swaps a gift off an
old charge whose `rawCharge.status === 'failed'`, the orphan lands
`excluded`/`failed_charge`, never back in `pending` (a failed charge is not
real unmatched money). Mirrors the single-charge revert.

**Why:** two prod dead-ends (identical-amount donation pair auto-matched to the
wrong donor; a gift sourced from a declined charge blocking its retry charge).
**How to apply:** any new retarget/unlink path must re-check all three staged
gift-link columns for movability and keep the unwind order + both-sides tie
recompute.
