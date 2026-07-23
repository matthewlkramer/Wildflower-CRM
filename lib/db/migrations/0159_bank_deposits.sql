-- 0159: create bank_deposits — the SPINE of the bank-anchored money model
-- (docs/adr-bank-spine-money-model.md, Phase 1).
--
-- A bank_deposits row is a real bank credit. Today it is a curated PROJECTION
-- of a deposit-type bank_transactions row (source='qbo_register_export',
-- deposit IS NOT NULL AND deposit > 0) — QBO's own mirror of the bank feed.
-- When a bank-native feed (Plaid) or a manual deposit arrives, the SAME table
-- is repopulated from the better source without changing the schema or anything
-- that hangs off it (stripe_payouts.bank_deposit_id, bank_deposit_components).
--
-- Composition state (unresolved/partial/complete/overallocated) is DERIVED, not
-- stored (replit.md invariant #3).
--
-- WHY SAFE: additive only. Creates one enum + one table + indexes (all
-- idempotent) and an idempotent projection INSERT (ON CONFLICT (id) DO NOTHING,
-- deterministic ids). No existing table/column is touched; no reads depend on
-- this table yet. Re-runnable.
--
-- Run (human, from repo root, AFTER Publish or standalone — safe either way):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0159_bank_deposits.sql

DO $$ BEGIN
  CREATE TYPE bank_deposit_source AS ENUM ('qbo_register_export', 'plaid', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bank_deposits (
  id text PRIMARY KEY,
  source bank_deposit_source NOT NULL,
  source_bank_transaction_id text REFERENCES bank_transactions(id) ON DELETE SET NULL,
  deposit_date date NOT NULL,
  amount numeric(14, 2) NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  account text,
  location text,
  reference text,
  memo text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT bank_deposits_amount_positive_chk CHECK (amount > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_deposits_source_bank_transaction_id_uq
  ON bank_deposits (source_bank_transaction_id)
  WHERE source_bank_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bank_deposits_deposit_date_idx ON bank_deposits (deposit_date);
CREATE INDEX IF NOT EXISTS bank_deposits_amount_idx ON bank_deposits (amount);
CREATE INDEX IF NOT EXISTS bank_deposits_account_idx ON bank_deposits (account);

-- Idempotent projection from QBO's register mirror. Deterministic id
-- (bdep_<source bnk hash>) so a re-run inserts nothing new.
INSERT INTO bank_deposits (
  id, source, source_bank_transaction_id, deposit_date, amount,
  currency, account, location, reference, memo
)
SELECT
  'bdep_' || substring(bt.id FROM 5),
  'qbo_register_export',
  bt.id,
  bt.txn_date,
  bt.deposit,
  'USD',
  bt.account,
  bt.location,
  bt.ref_no,
  bt.memo
FROM bank_transactions bt
WHERE bt.source = 'qbo_register_export'
  AND bt.deposit IS NOT NULL
  AND bt.deposit > 0
ON CONFLICT (id) DO NOTHING;
