---
name: Stripe restricted live key vs connector
description: How the Stripe sync chooses credentials and derives the account id when the read-only LIVE restricted key secret is present.
---

The Replit Stripe connector only authorizes in TEST/sandbox mode, so real LIVE
data can't be pulled through it. To import real money, set the secret
`STRIPE_RESTRICTED_KEY` (a `rk_live_...` read-only restricted key).

**Resolution rule:** `getUncachableStripeClient()` PREFERS the restricted key when
the secret is set, and falls back to the connector when it's absent.
`stripeConfigured()` (= restricted key present OR connector available) gates the
scheduler, so the sync runs when only the secret is set. Never log the key.

**Why:** connector live-mode is not grantable; the secret is the only path to real
Stripe data, but the connector path must stay intact for environments without it.

**Account id without the KYC scope:** a minimal read-only restricted key usually
LACKS `accounts_kyc_basic_read`, so `accounts.retrieveCurrent()` 403s. The code
recovers the `acct_...` id by regexing it out of the permission error
(`raw.request_log_url` / `raw.message` / `message`), caches it module-level, and
logs the mode once. So you do NOT need the "Basic business contact info" scope —
only read access to payouts, charges, and balance_transactions (the sync expands
`data.source` on balance transactions).

**Backfill never seeds the watermark:** `syncStripeBackfill({from,to})` pulls the
back-catalogue directly and intentionally does NOT create/move a
`stripe_sync_state` row — so after a backfill the restricted account will have rows
in `stripe_payouts`/`stripe_staged_charges` but NO `sync_state` entry (that's
expected, not a bug). `syncStripe()` (the "Sync now" route, admin-only) is
ongoing-only: its first run for a new account seeds watermark=now and stages
nothing — it will not load history. There is currently no route/CLI wiring for
`syncStripeBackfill` (it's otherwise unreferenced).
