-- 0166: Phase 7 — QBO expected-vs-actual accounting sidecar
-- (docs/adr-bank-spine-money-model.md). Once the real chain is resolved
-- (bank deposit → payout/checks → payment units → gifts/allocations), the
-- expected QBO posting is derivable; this table records the comparison per QBO
-- record. Accounting REVIEW, never a money ledger: it never counts as money,
-- and the CRM never writes to QBO — correction_needed is a worklist for fixing
-- QBO in QBO.
--
-- DDL only; the comparer (app/report code) lands separately and upserts by
-- deterministic id qac_<staged_payment_id>.
--
-- WHY SAFE: purely additive (new enum + empty table). Idempotent.
--
-- Run (human, repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0166_qbo_accounting_checks.sql

DO $$ BEGIN
  CREATE TYPE qbo_accounting_disposition AS ENUM (
    'consistent',
    'correction_needed',
    'corrected',
    'accepted_historical'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS qbo_accounting_checks (
  id text PRIMARY KEY,
  staged_payment_id text NOT NULL REFERENCES staged_payments(id) ON DELETE CASCADE,
  expected jsonb,
  actual jsonb,
  disposition qbo_accounting_disposition NOT NULL,
  note text,
  resolved_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamp with time zone,
  computed_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS qbo_accounting_checks_staged_payment_id_uq
  ON qbo_accounting_checks (staged_payment_id);
CREATE INDEX IF NOT EXISTS qbo_accounting_checks_disposition_idx
  ON qbo_accounting_checks (disposition);
