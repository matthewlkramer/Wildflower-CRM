-- 0161: create bank_deposit_components — the components (checks / direct
-- payments) that compose a bank deposit (docs/adr-bank-spine-money-model.md,
-- Phase 3). Table only; the QBO-inferred BACKFILL is a separate, later migration
-- (see note below).
--
-- One row = "this check payment_unit is part of THIS bank deposit, for THIS
-- amount." Use ONLY for payments that directly compose a deposit (checks, direct
-- ACH/wire). Stripe charges are NOT components (a charge composes a payout; the
-- payout composes the deposit — Phase 4). Composition state
-- (unresolved/partial/complete/overallocated) is DERIVED, never stored.
--
-- WHY SAFE: additive only (one table + one enum + indexes, all idempotent). No
-- existing table is touched; nothing reads it yet. Re-runnable.
--
-- BACKFILL DEFERRED (intentional): seeding components from QBO requires two
-- inference rules that write MONEY-COMPOSITION data and therefore need explicit
-- sign-off before they run:
--   (1) which register-projected bank_deposits row a QBO Deposit maps to
--       (amount + date + account matching — the "tie the determinative chain to
--       flaky QBO" judgment surface), and
--   (2) a dedup rule so QBO check rows do NOT re-unitize Stripe/Donorbox money
--       already represented by payment_units (Phase 2).
-- Those land in 0162 once the rules are confirmed, so the composition backfill
-- is reviewed as its own migration rather than bundled with the DDL.
--
-- Run (human, repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0161_bank_deposit_components.sql

DO $$ BEGIN
  CREATE TYPE bank_deposit_component_source AS ENUM ('qbo_inferred', 'check_register', 'bank_data', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bank_deposit_components (
  id text PRIMARY KEY,
  bank_deposit_id text NOT NULL REFERENCES bank_deposits(id) ON DELETE RESTRICT,
  payment_unit_id text NOT NULL REFERENCES payment_units(id) ON DELETE RESTRICT,
  amount numeric(14, 2) NOT NULL,
  source bank_deposit_component_source NOT NULL,
  source_staged_payment_id text REFERENCES staged_payments(id) ON DELETE SET NULL,
  needs_review boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT bank_deposit_components_amount_positive_chk CHECK (amount > 0)
);

-- A check unit composes exactly one deposit.
CREATE UNIQUE INDEX IF NOT EXISTS bank_deposit_components_payment_unit_id_uq
  ON bank_deposit_components (payment_unit_id);
CREATE INDEX IF NOT EXISTS bank_deposit_components_bank_deposit_id_idx
  ON bank_deposit_components (bank_deposit_id);
CREATE INDEX IF NOT EXISTS bank_deposit_components_source_staged_payment_id_idx
  ON bank_deposit_components (source_staged_payment_id);
