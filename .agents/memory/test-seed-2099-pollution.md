---
name: Far-future test-seed pollution in dev DB
description: Killed integration-test runs leave 2099-dated seed rows that crowd proximity-ordered searches out of their LIMIT; clean by date band in FK order.
---

Reconciliation integration suites seed gifts/staged payments/charges with far-future
dates (~2099) to stay clear of real data, and clean up in `afterAll`. When a run is
killed mid-suite (CPU throttling, timeouts — a known recurring event in this
environment), those rows survive in the dev DB.

**Symptom:** `reconciliation-search-split.integration.test.ts` (or any test relying
on a date-proximity-ordered, LIMIT'd search around a 2099 anchor) fails
deterministically — leftover 2099 rows from OTHER suites sit closer to the anchor
and crowd the expected candidate out of the LIMIT 25. The failure looks like a code
regression but reproduces even on untouched search code.

**Why:** split-mode gift search drops the date window entirely and orders by
`ABS(date_received - anchor)`; anything dated 2099 outranks the seeded early-date
gift, and only test rows live in that band.

**How to fix:** delete everything in the far-future band (`date_received BETWEEN
'2098-01-01' AND '2100-12-31'` — no legitimate data lives there) in FK order:

1. `payment_applications` (by gift_id AND by payment_id)
2. `settlement_links` (by deposit_staged_payment_id — a CHECK constraint forbids
   the ON DELETE SET NULL path when status is confirmed)
3. `staged_payments`, `stripe_staged_charges`
4. `gift_allocations`, then `gifts_and_payments`

Then re-run the failing file in isolation to confirm.
