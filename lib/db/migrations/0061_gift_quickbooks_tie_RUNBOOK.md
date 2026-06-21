# Runbook — 0061 Gift ↔ QuickBooks tie status + off-books flag

## What this does

Adds the schema behind the "Anchor gifts to QuickBooks / flag off-books gifts"
feature (INV-2/3/10):

1. enum `gift_quickbooks_tie` (`exempt | tied | amount_mismatch | missing`)
2. `gifts_and_payments.off_books_fiscal_sponsor` — `boolean NOT NULL DEFAULT false`
3. `gifts_and_payments.quickbooks_tie_status` — `gift_quickbooks_tie NOT NULL DEFAULT 'missing'`
4. index `gifts_and_payments_quickbooks_tie_status_idx`

Purely additive — no data is changed or dropped.

## Why this is a hand-applied SQL file (not just Publish)

`drizzle-kit push` currently **aborts on a pre-existing, unrelated drift** in
the live DB (`opportunities.conditions_met` tri-state). An aborted push skips
**all** additive changes, including these columns, so the Publish schema diff
cannot be trusted to land them. This idempotent file applies the additive
changes directly without approving the unrelated drop.

## Apply

Run **before** deploying the code that reads these columns (the API contract now
selects `off_books_fiscal_sponsor` / `quickbooks_tie_status`):

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0061_gift_quickbooks_tie.sql
```

For production, use `$PROD_DATABASE_URL`:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0061_gift_quickbooks_tie.sql
```

## Then backfill the derived status

Every existing gift lands at the default `missing`. Recompute the real tie
status afterwards:

```bash
pnpm --filter @workspace/api-server run backfill:gift-qb-tie
```

## Idempotency

Safe to re-run: the enum is guarded by a `pg_type` check and the columns/index
use `IF NOT EXISTS`. A second run is a no-op.

## Verify

```sql
SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'gifts_and_payments'
   AND column_name IN ('off_books_fiscal_sponsor', 'quickbooks_tie_status')
 ORDER BY column_name;
-- Expect both NOT NULL with defaults false / 'missing'.

SELECT unnest(enum_range(NULL::gift_quickbooks_tie));
-- Expect: exempt, tied, amount_mismatch, missing.
```
