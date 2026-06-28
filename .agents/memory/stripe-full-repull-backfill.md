---
name: Stripe full re-pull (historical payout backfill)
description: Why QBO-only reconciliation cards lack a Stripe payout for old years, and how the admin full re-pull recovers them (plus the no-cursor gotcha).
---

# Stripe full re-pull (historical payout backfill)

The ongoing Stripe → CRM sync (`syncStripe`) is incremental: its per-account
cursor (`stripe_sync_state.payout_created_watermark`) is **seeded to "now" on the
first-ever run**, and that first run stages nothing. So any payout created before
the sync was first switched on (e.g. 2019–2021) was NEVER pulled — which is why
some reconciliation cards show a QuickBooks deposit lump with no Stripe payout
behind it. By-design first-cut behavior, NOT a forgotten pull. (User clarified
payouts sit in Stripe until manually requested — doesn't change the diagnosis.)

**Recovery (single account):** there is one Stripe account, reachable by API back
to ~2018, so no CSV is needed (contrast `stripe-history-csv-backfill.md`, which is
for a *prior* account only loadable from CSV). `syncStripe({ fullResync: true })`
lifts the watermark floor (`watermark = null`, which drops the `created >= floor`
filter in `stripe.payouts.list`) and re-walks the ENTIRE payout back-catalogue,
backfilling the missing payout + charge rows non-destructively (the upsert only
refreshes read-only Stripe facts; review/donor/gift state is preserved). It runs
in the background (multi-minute → exceeds the proxy timeout) and is polled —
mirrors the QuickBooks full re-pull pattern exactly.

**Why:** the gotcha to avoid — the `if (!state)` first-run branch seeds the cursor
and returns early. A `fullResync` MUST NOT short-circuit there or it silently
stages nothing on any env whose `stripe_sync_state` row doesn't exist yet (fresh
dev DB, successor-task env).

**How to apply:** only early-return when `!fullResync`; for fullResync, seed the
cursor and fall through to the full walk (and keep the `watermark`/`maxCreated`
derivation null-safe on `state`). Prod flow is human-run (agent can't write prod):
Publish → confirm Stripe sync is configured → "Full re-pull" (wait for `done`,
`ran:true`) → "Propose historical matches" (re-runs Stripe→QB proposals across
ALL payouts incl. the freshly backfilled ones; proposals only, a human confirms).
