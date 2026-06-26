-- 0079_staged_payment_qb_location.sql
--
-- Promotes the reconciler card's QuickBooks "Location/Department" from a
-- query-time derivation (qb_raw->'DepartmentRef'->>'name') into a real captured
-- column, `staged_payments.qb_location`, populated at sync time alongside the
-- other qb_* facts.
--
-- The column itself ships to prod via the normal Publish (schema-diff) flow.
-- This file only BACKFILLS the column on rows ingested before the deploy, by
-- copying the value out of the already-stored raw QB payload. From the deploy
-- onward the sync worker writes qb_location directly, so this is a one-time
-- catch-up for the historical back-catalog.
--
-- DATA-ONLY, non-destructive, idempotent. Safe to run more than once.
--
-- The ADD COLUMN IF NOT EXISTS below is a defensive no-op when Publish has
-- already added the column (the normal ordering); it only matters if this file
-- is ever applied before the schema deploy.

ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS qb_location text;

-- Backfill from the verbatim raw payload. Only touches rows that still have no
-- captured location AND whose raw payload actually carries one, so re-runs and
-- rows the sync worker has since populated are left untouched.
UPDATE staged_payments
SET qb_location = qb_raw->'DepartmentRef'->>'name',
    updated_at  = now()
WHERE qb_location IS NULL
  AND qb_raw->'DepartmentRef'->>'name' IS NOT NULL;
