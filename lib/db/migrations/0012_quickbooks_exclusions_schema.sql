-- Migration 0012: QuickBooks payment-sync — exclusion state + line-item audit
--
-- Adds the schema backing "auto-exclude noise QuickBooks payments" (zero-amount,
-- school loans, school membership dues). Excluded rows are MARKED, never deleted:
-- they stay synced and auditable, are hidden from the default (pending) queue,
-- and can be re-included to pending if wrongly excluded.
--
-- Adds:
--   * enum value  staged_payment_status += 'excluded'
--   * enum         staged_payment_exclusion_reason
--                  ('zero_amount' | 'loan' | 'membership')
--   * column       staged_payments.exclusion_reason   (set only when excluded)
--   * columns      staged_payments.line_item_names    text[]  (QB Product/Service
--                  staged_payments.line_account_names text[]   item / income account
--                  staged_payments.line_classes       text[]   / class names, captured
--                                                              at pull time for the
--                                                              membership classifier
--                                                              and for auditing)
--
-- WHY line-item columns: most rows are QB Payment entities, which carry no line
-- items themselves — the membership item lives on the LINKED Invoice. The pull
-- now follows LinkedTxn to the invoice and stores the item/account/class names
-- here so the classifier can flag membership and a human can audit every
-- exclusion. SalesReceipt/Deposit store their own line detail directly.
--
-- ORDER: run this BEFORE deploying the new app code (the sync/classifier and the
-- review-queue endpoints read/write these columns and the 'excluded' status).
-- The data BACKFILL of the existing ~3,000 queued rows is a SEPARATE migration
-- (0013) that must run AFTER this one commits — Postgres forbids using a freshly
-- added enum value in the same transaction that added it.
--
-- Non-destructive + idempotent: ADD VALUE IF NOT EXISTS / ADD COLUMN IF NOT
-- EXISTS / guarded CREATE TYPE. A second run is a no-op; no existing data is
-- touched (existing rows keep status 'pending' with NULL exclusion_reason).
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0012_quickbooks_exclusions_schema.sql

-- New review-queue status. ADD VALUE IF NOT EXISTS is safe to re-run; it does not
-- USE the value, so it is fine inside the wrapping transaction (PG 12+).
ALTER TYPE staged_payment_status ADD VALUE IF NOT EXISTS 'excluded';

-- Exclusion-reason enum (guarded — CREATE TYPE has no IF NOT EXISTS).
DO $$ BEGIN
  CREATE TYPE staged_payment_exclusion_reason
    AS ENUM ('zero_amount', 'loan', 'membership');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS exclusion_reason   staged_payment_exclusion_reason;
ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS line_item_names    text[];
ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS line_account_names text[];
ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS line_classes       text[];

-- Verification:
--   SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
--   WHERE t.typname = 'staged_payment_status';   -- includes 'excluded'
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'staged_payments'
--     AND column_name IN ('exclusion_reason','line_item_names',
--                         'line_account_names','line_classes');  -- 4 rows
