# Runbook — 0062 Stripe refund / chargeback propagation (INV-13)

## What this does

Adds the schema behind "Propagate Stripe refunds/chargebacks to CRM gifts via
propose-then-confirm":

1. enum `stripe_refund_propagation_status` (`none | proposed | applied | dismissed`)
2. enum `stripe_refund_kind` (`full_refund | partial_refund | chargeback`)
3. columns on `stripe_staged_charges`:
   - `refund_propagation_status` — `stripe_refund_propagation_status NOT NULL DEFAULT 'none'`
   - `refund_propagation_kind` — `stripe_refund_kind` (nullable)
   - `refund_propagation_gift_id` — `text` FK → `gifts_and_payments(id)` `ON DELETE SET NULL`
   - `refund_proposed_amount` — `numeric(14,2)` (nullable)
   - `refund_confirmed_by_user_id` — `text` FK → `users(id)` `ON DELETE SET NULL`
   - `refund_confirmed_at` — `timestamptz` (nullable)
4. partial index `stripe_staged_charges_refund_propagation_idx`
   `WHERE refund_propagation_status = 'proposed'`

Purely additive — no data is changed or dropped. Every existing row lands at
`refund_propagation_status = 'none'`, so no proposals are raised retroactively;
the Stripe sync worker raises them going forward as it sees refunds/disputes.

## Why this is a hand-applied SQL file (not just Publish)

`drizzle-kit push` currently **aborts on a pre-existing, unrelated drift** in the
live DB (`opportunities.conditions_met` tri-state). An aborted push skips **all**
additive changes, including these columns, so the Publish schema diff cannot be
trusted to land them. This idempotent file applies the additive changes directly
without approving the unrelated drop.

## Apply

Run **before** deploying the code that reads these columns (the API contract now
selects the `refund_*` fields, and the routes confirm/dismiss proposals):

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0062_stripe_refund_propagation.sql
```

For production, use `$PROD_DATABASE_URL`:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0062_stripe_refund_propagation.sql
```

## No backfill

Nothing to backfill — proposals are raised forward-only by the Stripe sync
worker the next time it pulls a payout containing a refunded/disputed charge.

## Idempotency

Safe to re-run: enums are guarded by `pg_type` checks, columns use
`IF NOT EXISTS`, FKs are added only when `pg_constraint` lacks them, and the
index uses `IF NOT EXISTS`. A second run is a no-op.

## Verify

```sql
SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'stripe_staged_charges'
   AND column_name LIKE 'refund_%'
 ORDER BY column_name;
-- Expect refund_propagation_status NOT NULL default 'none'; the rest nullable.

SELECT unnest(enum_range(NULL::stripe_refund_propagation_status));
-- Expect: none, proposed, applied, dismissed.

SELECT unnest(enum_range(NULL::stripe_refund_kind));
-- Expect: full_refund, partial_refund, chargeback.
```
