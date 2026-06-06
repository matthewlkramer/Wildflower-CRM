-- 0036_quickbooks_payer_type_and_raw.sql
-- Capture the QuickBooks payer type + every other useful QB field on staged
-- payments/deposits, plus the complete raw QB payload, verbatim.
--
-- WHY
--   The reconciler couldn't tell a Vendor/Employee payer (almost never a
--   donation) from a Customer, and high-value QB fields (payment method, check
--   number, deposit-to account, currency, billing address, linked txns, etc.)
--   were dropped at pull time. Storing the raw payload too means any future
--   field can be derived WITHOUT re-pulling from QuickBooks.
--
-- WHAT
--   1. New enum quickbooks_payer_type (vendor / customer / employee).
--   2. Additive, nullable columns on staged_payments for the structured fields
--      plus jsonb raw payload (entity) and raw deposit line.
--
-- SAFE / ADDITIVE
--   Every column is nullable with no default — pure ADD, no rewrite of existing
--   review state. Existing rows are then backfilled by a NON-destructive full
--   re-pull (see 0036_..._RUNBOOK.md) that refreshes these capture columns on
--   every row without touching any approval / match / exclusion / grouping.
--
-- IDEMPOTENT
--   Guarded with IF NOT EXISTS so a re-run is a no-op. Wrapped in one tx.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quickbooks_payer_type') THEN
    CREATE TYPE quickbooks_payer_type AS ENUM ('vendor', 'customer', 'employee');
  END IF;
END
$$;

ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS qb_payer_type            quickbooks_payer_type,
  ADD COLUMN IF NOT EXISTS qb_payer_id              text,
  ADD COLUMN IF NOT EXISTS qb_payment_method        text,
  ADD COLUMN IF NOT EXISTS qb_check_number          text,
  ADD COLUMN IF NOT EXISTS qb_deposit_to_account_name text,
  ADD COLUMN IF NOT EXISTS qb_doc_number            text,
  ADD COLUMN IF NOT EXISTS qb_billing_address       text,
  ADD COLUMN IF NOT EXISTS qb_transaction_memo      text,
  ADD COLUMN IF NOT EXISTS qb_currency              text,
  ADD COLUMN IF NOT EXISTS qb_exchange_rate         numeric(18, 6),
  ADD COLUMN IF NOT EXISTS qb_create_time           timestamptz,
  ADD COLUMN IF NOT EXISTS qb_linked_txn            jsonb,
  ADD COLUMN IF NOT EXISTS qb_raw                   jsonb,
  ADD COLUMN IF NOT EXISTS qb_raw_line              jsonb;

COMMIT;
