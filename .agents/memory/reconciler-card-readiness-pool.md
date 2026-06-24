---
name: Reconciler card readiness / auto-proposal pool
description: How a reconciliation card becomes "ready" (one-click/bulk-approvable) and the shared gift pool that drives it.
---

# Reconciler card readiness (auto-proposal gift pool)

In `routes/reconciliation/cards.ts` a single predicate function (named `n()`,
documented as `unlinkedDonorGiftWhere`) defines the *auto-proposal gift pool* for
a staged payment: same single donor, amount inside the fee band
(`>= staged.amount - 0.01` and `<= staged.amount * 1.10 + 1`), not archived, not
already linked elsewhere (`qbLedgerExistsForGiftExcludingPayment`), and **date
proximate** (`READY_GIFT_DATE_WINDOW_DAYS = 90`).

The same predicate feeds `autoGiftCountExpr`, `autoGiftPickExpr`, and `readyExpr`
— keep them sharing one function so count / pick / ready can never drift. A card
is `ready` only when: `status='pending'` AND `matchStatus='matched'` AND exactly
one donor FK set AND the pool has exactly **one** gift. `ready` is additionally
gated `!isSourceGroup` in the response mapping.

## Date clause is STRICT, not NULL-tolerant
Both `staged.date_received` and `gift.date_received` must be NOT NULL, then
`ABS(diff) <= 90`.

**Why:** "dates within a few months" cannot be proven when a date is missing, so a
date-less gift must never auto-ready (it stays manually matchable). Prod-verified
the matched/pending/single-donor pool always has a populated staged date, so
strict vs null-tolerant is identical on current data — strict is just safer.

**How to apply:** if you ever loosen this to NULL-tolerant, you are choosing to
auto-ready money whose timing is unknown — don't, unless the product explicitly
wants that. The card-readiness window (90d) is intentionally separate from and
wider than the matcher's `GIFT_WINDOW_DAYS` (60); changing one must not silently
change the other.

## Scope
`n()` is used ONLY in cards.ts (the list/queue), NOT in `approve.ts` (the approve
endpoint runs its own full consistency gate). Loosening/tightening the pool only
changes which cards *light up* as one-click-ready — it does not change what
approve will accept.
