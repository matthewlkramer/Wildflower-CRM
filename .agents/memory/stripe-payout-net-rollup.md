---
name: Stripe payout net_total = true ledger net
description: Rollup rule for stripe_payouts totals — adjustment bucket, payout-txn skip, and why net_total must equal the bank amount when books balance.
---

**Rule:** `net_total` on `stripe_payouts` is the true Stripe-ledger net:
`gross − fee − refund + adjustment`, which equals the bank `amount` whenever
Stripe's books balance. `adjustment_total` carries the net of every
non-charge/payment/refund balance-transaction type (fee-refund `adjustment`,
`payment_failure_refund` reversals, `payout_failure` recoveries).

**Why:** The old rollup (gross − fee − refund only) silently ignored
adjustment-type balance txns, so payouts absorbing one carried a permanently
wrong net_total and were flagged forever by the settlement-gap lens
(|net_total − amount| ≥ 0.005) — 5 phantom "Settlement gaps" in prod, all of
which balanced exactly against Stripe's ledger. Every consumer audited treats
net_total as a bank-amount proxy (`COALESCE(net_total, amount)`), so the old
inflated value was also a latent bug in coverage predicates
(depositFullyCovered demanded coverage of money the bank never received).

**How to apply:**
- In `rollupPayout()` always SKIP the payout's own `type='payout'` txn (the
  balance-txn list for a payout includes it).
- Route any txn type that isn't charge/payment/refund/payment_refund through
  the adjustment bucket via `bt.net` (its own fee is inside net — adding fee
  separately double-counts). This keeps the tested invariant
  `netTotal == Σ bt.net (non-payout)` true for ANY future txn type Stripe adds.
- `fee_total` = fees on charge/payment txns only, NOT all txns.
- No SQL backfill for rollup fixes — the admin "full re-pull"
  (POST /stripe/resync-full) recomputes every payout from Stripe and preserves
  review state. Dev's Stripe key is a sandbox, so dev rows mirroring prod
  payouts can only be corrected by SQL, never by a dev resync.
- Watch for dev-mirror sign drift: dev's stale copies of NEGATIVE payouts
  (bank-debit withdrawals) stored absolute values for `amount`; prod stores the
  signed value (bt for a payout has amount = −payout.amount).
- Shipping a column the sync writes on every upsert: apply the ADD COLUMN
  migration BEFORE Publish (harmless to old code) so there is no window where
  new code 500s/fails sync on a missing column.
