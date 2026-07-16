# Runbook: 0130 — Drop gifts_and_payments.final_amount_qb_staged_payment_id

## What this migration does

Drops the `final_amount_qb_staged_payment_id` column from `gifts_and_payments`.
This is the last of four legacy QB gift-pointer columns:

| Column | Table | Dropped by |
|---|---|---|
| `matched_gift_id` | `staged_payments`, `stripe_staged_charges`, `donorbox_donations` | 0126 |
| `created_gift_id` | same | 0126 |
| `group_reconciled_gift_id` | `staged_payments` | 0126 |
| `final_amount_qb_staged_payment_id` | `gifts_and_payments` | **0130 (this file)** |

The counted `payment_applications` ledger is the sole QB↔gift link record since
migration 0120 (parity backfill). This column was never read or written after
the read cutover; it was kept physical until this reviewed drop shipped.

## Pre-checks (run first)

Confirm no non-null values remain (expect **0**):

```sql
SELECT count(*)
FROM gifts_and_payments
WHERE final_amount_qb_staged_payment_id IS NOT NULL;
```

All values should be NULL (the ledger backfill in 0120 and the null-clear code
path in the approve route kept this column empty after the read cutover).

## Apply

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0130_drop_final_amount_qb_staged_payment_id.sql
```

The statement is idempotent (`DROP COLUMN IF EXISTS`) and runs outside a
transaction wrapper — psql's `-1` flag wraps it in one automatically.

## Post-verify

Confirm the column is gone:

```sql
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'gifts_and_payments'
  AND column_name = 'final_amount_qb_staged_payment_id';
-- Expect 0 rows.
```

## Rollback

There is no rollback path — data loss would be involved in re-adding this
column (it has been NULL in every row since the 0120 backfill). If a rollback
is needed, the column can be re-added with all NULLs via:

```sql
ALTER TABLE gifts_and_payments
  ADD COLUMN IF NOT EXISTS final_amount_qb_staged_payment_id text;
```

But this should never be needed: the column was never read or written after the
ledger read cutover, and re-adding it would require re-introducing the FK
constraint against `staged_payments` (ON DELETE RESTRICT).
