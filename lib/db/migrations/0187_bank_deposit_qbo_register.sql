-- 0187: typed linkage from componentless Wells Fargo deposits to QBO register rows.
--
-- QBO customer Payments, Journals, and Transfers can represent the same money
-- as a Wells Fargo bank credit without appearing as members of a QBO Deposit.
-- The bank-register export is therefore retained as accounting evidence and
-- linked separately from deposit_qbo_components. This table never composes
-- payment units, mints gifts, anchors payment applications, or auto-excludes
-- deposits.
--
-- The fill-only matcher writes only unique exact-amount pairs within a
-- +/- 3-day date window. `ambiguous` is reserved for a future
-- human-candidate-surfacing workflow and remains false in this release.
--
-- Future attribution remains deliberately out of scope. When implemented,
-- any payment from a Wildflower school is earned income or a loan payment,
-- never a donation; this migration does not classify any register row.
--
-- Apply after Publish, by a human, to both environments:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0187_bank_deposit_qbo_register.sql
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0187_bank_deposit_qbo_register.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

CREATE TABLE IF NOT EXISTS bank_deposit_qbo_register (
  id text PRIMARY KEY,
  bank_deposit_id text NOT NULL
    REFERENCES bank_deposits(id) ON DELETE RESTRICT,
  bank_transaction_id text NOT NULL
    REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  amount numeric(14, 2) NOT NULL,
  ambiguous boolean NOT NULL DEFAULT false,
  matched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_deposit_qbo_register_amount_positive_chk CHECK (amount > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_deposit_qbo_register_bank_deposit_id_uq
  ON bank_deposit_qbo_register(bank_deposit_id);
CREATE UNIQUE INDEX IF NOT EXISTS bank_deposit_qbo_register_bank_transaction_id_uq
  ON bank_deposit_qbo_register(bank_transaction_id);
CREATE INDEX IF NOT EXISTS bank_deposit_qbo_register_bank_deposit_id_idx
  ON bank_deposit_qbo_register(bank_deposit_id);
CREATE INDEX IF NOT EXISTS bank_deposit_qbo_register_bank_transaction_id_idx
  ON bank_deposit_qbo_register(bank_transaction_id);
