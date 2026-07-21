# Runbook — Migration 0146: drop transitional gift/org columns (Task #757)

## What it does

One idempotent file, two steps, applied in a single transaction (`-1`):

1. **Backfill** — any remaining non-null `organizations.payment_intermediary_id`
   is inserted into `donor_payment_intermediaries` (deterministic
   `dpibf_<orgId>` ids, `ON CONFLICT DO NOTHING`, skips dangling intermediary
   FKs via the JOIN). Skipped entirely if the column is already dropped.
2. **Drop** — `organizations.payment_intermediary_id` (+ its index),
   `gifts_and_payments.final_amount_source`,
   `gifts_and_payments.original_human_crm_amount`, and the now-unused
   `gift_final_amount_source` enum type.

Dev status: dev DB had **0** rows with a non-null org
`payment_intermediary_id` (verified 2026-07-21), so the dev backfill was a
no-op; the dev columns stay physical until this file is applied there too (or
left — code never touches them).

## Preconditions

- The api-server build from Task #757 is **deployed** (Publish done). The
  deployed code has no reads/writes/echoes of any of the three columns.

## Verify before (prod)

```sql
-- How many org links will be backfilled?
SELECT count(*) FROM organizations WHERE payment_intermediary_id IS NOT NULL;
-- Of those, how many already have a dpi row (will be no-ops)?
SELECT count(*) FROM organizations o
JOIN donor_payment_intermediaries d
  ON d.organization_id = o.id
 AND d.payment_intermediary_id = o.payment_intermediary_id
WHERE o.payment_intermediary_id IS NOT NULL;
```

## Apply

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0146_drop_transitional_gift_org_columns.sql
```

## Verify after

```sql
-- Backfilled rows are present:
SELECT count(*) FROM donor_payment_intermediaries WHERE id LIKE 'dpibf_%';
-- Columns are gone (expect 0 rows):
SELECT column_name FROM information_schema.columns
WHERE (table_name = 'organizations' AND column_name = 'payment_intermediary_id')
   OR (table_name = 'gifts_and_payments'
       AND column_name IN ('final_amount_source', 'original_human_crm_amount'));
-- Enum type is gone (expect 0 rows):
SELECT typname FROM pg_type WHERE typname = 'gift_final_amount_source';
```

Verify by row counts/state, not by clean exit.

## Rollback

Column drops are destructive; the transaction (`-1`) rolls back atomically on
any error. After a successful apply there is no in-place rollback — the
backfilled `dpibf_%` rows preserve the org→intermediary facts, and restoring
the columns would require a schema re-add + reverse backfill from those rows.

## After prod apply

Remove the three `@deprecated` column definitions from
`lib/db/src/schema/giftsAndPayments.ts` / `organizations.ts` (and the
`gift_final_amount_source` enum) in a follow-up code change, then rebuild lib
declarations. Until then the schema intentionally keeps them physical so dev
push and Publish stay additive.
