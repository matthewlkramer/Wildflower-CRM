-- 0170: add Wells Fargo bank-source schema required by the importer.
--
-- APPLY ORDER:
--   1. Apply this file (0170).
--   2. Run `pnpm --filter @workspace/scripts run import:bank-csv`.
--   3. Apply `lib/db/migrations/0171_wells_fargo_bank_spine_cutover.sql`.
--
-- The enum additions must be isolated in this DDL-only migration. The repo
-- applies migrations with `psql -1`; PostgreSQL rejects using an enum value in
-- the same transaction that added it. This mirrors
-- `0155_deposit_header_entity_type.sql`.
--
-- Idempotent and safe to re-run.

ALTER TYPE bank_transaction_source ADD VALUE IF NOT EXISTS 'bank_csv_export';
ALTER TYPE bank_deposit_source ADD VALUE IF NOT EXISTS 'bank_csv_export';

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS qb_posting text,
  ADD COLUMN IF NOT EXISTS donor text;
