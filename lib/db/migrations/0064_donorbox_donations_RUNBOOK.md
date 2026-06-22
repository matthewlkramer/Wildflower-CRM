# Runbook — 0064 Donorbox donation sync

## What this does

Adds the schema behind the Donorbox API pull-sync (enrichment + non-Stripe
new-money review):

1. enum `donorbox_exclusion_reason` (`already_booked | duplicate | not_a_gift | other`)
2. table `donorbox_donations` — one row per Donorbox donation (PK = Donorbox id):
   read-only Donorbox facts (amount, refund, campaign/designation/comment, donor
   profile, raw payload) + a non-Stripe new-money review block mirroring
   `stripe_staged_charges` (status / donor XOR FKs / gift linkage).
3. table `donorbox_sync_state` — singleton run-state + a `donation_date` watermark.
4. indexes — including the **partial-unique `stripe_charge_id`** enrichment join
   key (1:1 with `stripe_staged_charges.id`) and the 1:1 donation↔gift link guards.

Purely additive — no existing table is touched and nothing is dropped.

## Why this is a hand-applied SQL file (not just Publish)

`drizzle-kit push` currently **aborts on a pre-existing, unrelated drift** in the
live DB (`opportunities.conditions_met` tri-state). An aborted push skips **all**
additive changes, so the Publish schema diff cannot be trusted to land these
tables. This idempotent file applies them directly without approving the
unrelated drop.

## Apply

Run **before** deploying the code that reads these tables:

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0064_donorbox_donations.sql
```

For production, use `$PROD_DATABASE_URL`:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0064_donorbox_donations.sql
```

## Then populate

The tables start empty. The first sync run does a **full historical pull**
(Stripe-type donations enrich existing gifts; non-Stripe land in the new-money
review queue). Trigger it on-demand:

```bash
pnpm --filter @workspace/api-server run sync:donorbox
```

(or wait for the 30-minute scheduler). Requires `DONORBOX_API_EMAIL` +
`DONORBOX_API_KEY` secrets to be set — the sync is a safe no-op until both are.

## Idempotency

Safe to re-run: the enum is guarded by a `pg_type` check; the tables and indexes
use `IF NOT EXISTS`. A second run is a no-op.

## Verify

```sql
SELECT to_regclass('donorbox_donations'), to_regclass('donorbox_sync_state');
-- Expect both non-null.

SELECT unnest(enum_range(NULL::donorbox_exclusion_reason));
-- Expect: already_booked, duplicate, not_a_gift, other.

SELECT indexname FROM pg_indexes WHERE tablename = 'donorbox_donations' ORDER BY indexname;
-- Expect the stripe_charge_id_uq / matched_gift_id_uq / created_gift_id_uq partial-unique indexes.
```
