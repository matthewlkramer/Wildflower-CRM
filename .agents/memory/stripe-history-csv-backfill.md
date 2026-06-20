---
name: Stripe balance-history CSV backfill
description: How/why a historical Stripe "Balance history" CSV is loaded into stripe_payouts + stripe_staged_charges, and the cross-env safety rules that constrain it.
---

# Stripe balance-history CSV backfill

A full Stripe **"Balance history"** CSV export can be loaded into `stripe_payouts`
+ `stripe_staged_charges` via a generated, idempotent SQL backfill (generator:
`lib/db/src/generate-stripe-history-sql.mjs`).

## Why a CSV at all (not the API sync)

The ongoing Stripe API sync is **watermark-based (ongoing-only)** and runs against
the **live connector account**. A historical export can belong to a **prior Stripe
account** whose money the live sync can never reach. Tell the accounts apart by the
**id infix**: every Stripe id (`po_…`, `ch_…`, `py_…`) carries a fixed
10-char account infix (e.g. the prior account `acct_1DF6BF**AhXr9x8yiR**` vs the
live connector `acct_1TjtNW…`). All backfilled rows are stamped with the prior
account's `stripe_account_id`. The generator hard-fails if any id lacks the infix —
this is the guard against importing the wrong account's CSV.

## Cross-env safety rules (the durable lessons)

- **Never bake donor/gift/intermediary FKs into the file.** Donor PKs drift between
  dev and prod, so dev-resolved donor ids would cause FK violations (or worse,
  mis-attribution) in prod. Import charges `status='pending'`, `match_status='unmatched'`
  with no donor FKs; resolve per-environment via the reconciliation queue. This keeps
  the file **byte-identical and safe for both dev and prod**.
  **Why:** the same file is applied to dev (by agent) and prod (by a human); any
  env-specific id embedded in it breaks one side.
- **Mirror `rollupPayout()` imperfections; keep `amount` authoritative.** Payout
  `gross/fee/refund/net_total` are rolled up exactly as the live `rollupPayout()`
  would (which excludes adjustments / payment_failure_refund), so a few old payouts
  have `amount != net_total` **by design**. `amount` = the payout row's own `Net`
  (true bank net). Don't "fix" the rollup to be more correct than the live code —
  the queue must see the same shape the sync produces.
  **Why:** divergence here is consistency with live semantics, not a bug.
- **`ON CONFLICT (id) DO NOTHING`, payouts before charges.** Additive + idempotent
  (re-run = `INSERT 0 0`); parent-before-child preserves the `stripe_payout_id` FK;
  any row the live sync later pulls is left untouched. An unsettled charge with no
  Transfer imports with `stripe_payout_id NULL` (can't be payout↔QB reconciled until
  a payout exists).
- **No Publish dependency.** `stripe_*` tables already exist in prod and no donor FKs
  are written, so the file applies any time (unlike schema-dependent data files).

## Regenerating

`node lib/db/src/generate-stripe-history-sql.mjs [input.csv] [output.sql]` —
deterministic (rows sorted by id), hand-rolled RFC4180 parser, mirrors
`stripeSync.ts` (`rollupPayout`, `chargeDateReceived` = America/Chicago,
2dp minor→amount). Hard-fail assertions: required headers, account-infix on every
id, no duplicate ids, every non-null payout reference present in the payout set.
