-- 0156: create bank_transactions — raw bank-register evidence, source-tagged.
--
-- One row per register line in the organization's bank account. Current
-- source is 'qbo_register_export' (seven overlapping QuickBooks Online
-- register XLS exports, 2016→2026, merged + deduplicated by the importer);
-- 'plaid' is reserved for a future live feed. Evidence only: read-only after
-- import, never mints gifts, never anchors payment_applications rows, and has
-- NO foreign keys — future cross-evidence ties go through the source_links
-- ledger once its ADR is implemented.
--
-- Dedup identity: dedup_key is the raw register field values
-- (date|ref|payee|memo|payment|deposit|type|balance); the same key can occur
-- more than once within one export (e.g. repeated voided payments at an
-- identical running balance), so occurrence (0-based) distinguishes copies
-- and the unique index makes re-imports idempotent.
--
-- Idempotent. Schema only — data is loaded by the importer script, which a
-- human runs against prod separately (see scripts import:bank-register).
--
-- Run (human, from repo root, AFTER Publish or standalone — safe either way):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0156_bank_transactions.sql

DO $$ BEGIN
  CREATE TYPE bank_transaction_source AS ENUM ('qbo_register_export', 'plaid');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bank_transactions (
  id text PRIMARY KEY,
  source bank_transaction_source NOT NULL,
  source_file text NOT NULL,
  txn_date date NOT NULL,
  txn_type text,
  ref_no text,
  payee text,
  memo text,
  class text,
  account text,
  location text,
  reconciliation_status text,
  added_in_banking text,
  payment numeric(14,2),
  deposit numeric(14,2),
  balance numeric(14,2),
  dedup_key text NOT NULL,
  occurrence integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_source_dedup_key_occurrence_uq
  ON bank_transactions (source, dedup_key, occurrence);
CREATE INDEX IF NOT EXISTS bank_transactions_txn_date_idx ON bank_transactions (txn_date);
CREATE INDEX IF NOT EXISTS bank_transactions_txn_type_idx ON bank_transactions (txn_type);
CREATE INDEX IF NOT EXISTS bank_transactions_deposit_idx ON bank_transactions (deposit);
CREATE INDEX IF NOT EXISTS bank_transactions_payee_idx ON bank_transactions (payee);
