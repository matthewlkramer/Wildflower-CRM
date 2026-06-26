# 0079 — Backfill `staged_payments.qb_location`

**Type:** DATA-ONLY, non-destructive, idempotent. The column ships via Publish;
this file only backfills historical rows.

## Why

The reconciler card's QuickBooks "Location" line was being derived at query time
from the stored raw payload (`qb_raw->'DepartmentRef'->>'name'`). It is now a
real captured column, `staged_payments.qb_location`, written at sync time next to
the other `qb_*` facts (matching `qb_transaction_memo`, `qb_doc_number`, etc.).

From the deploy onward the sync worker populates `qb_location` directly. This file
is a one-time catch-up that copies the value out of the already-stored raw QB
payload for rows ingested before the deploy.

## Ordering

Run **after** Publish (the schema diff adds the `qb_location` column to prod). The
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in the SQL is a defensive no-op for the
normal ordering; it only matters if the file is somehow applied first.

## Pre-check (read-only)

```sql
-- How many rows WILL be backfilled (rows with a location in the raw payload but
-- no captured column yet):
SELECT count(*) AS will_update
FROM staged_payments
WHERE qb_location IS NULL
  AND qb_raw->'DepartmentRef'->>'name' IS NOT NULL;

-- Distribution of the locations that will be captured:
SELECT qb_raw->'DepartmentRef'->>'name' AS location, count(*)
FROM staged_payments
WHERE qb_location IS NULL
  AND qb_raw->'DepartmentRef'->>'name' IS NOT NULL
GROUP BY 1
ORDER BY 2 DESC;
```

## Apply (from the repo root)

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0079_staged_payment_qb_location.sql
```

Expected output: `ALTER TABLE` then `UPDATE <n>` (n = the `will_update` count).

## Post-check (read-only)

```sql
-- Every row that has a DepartmentRef in its raw payload now has it captured
-- (expect 0 remaining):
SELECT count(*) AS still_uncaptured
FROM staged_payments
WHERE qb_location IS NULL
  AND qb_raw->'DepartmentRef'->>'name' IS NOT NULL;

-- Captured locations:
SELECT qb_location, count(*)
FROM staged_payments
WHERE qb_location IS NOT NULL
GROUP BY 1
ORDER BY 2 DESC;
```

## Idempotency

Re-running is a safe no-op: the `WHERE qb_location IS NULL` guard skips every row
already captured (by this backfill or by the live sync worker), so a second run
reports `UPDATE 0`. The backfill never overwrites a value the worker has written.

## Rollback (only if needed)

```sql
-- Clears only locations that still exactly equal the raw-derived value (so a
-- value the sync worker has since refreshed is never touched):
UPDATE staged_payments
SET qb_location = NULL, updated_at = now()
WHERE qb_location = qb_raw->'DepartmentRef'->>'name';
```
