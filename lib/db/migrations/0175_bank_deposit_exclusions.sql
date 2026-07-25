-- 0175: bank_deposit_exclusions — reviewed deposit-level "not fundraising" authority.
--
-- Records the human decision to treat a specific bank deposit as
-- Not-fundraising directly on the bank-deposit spine, for deposits that have no
-- QBO/staged-payment record to hang an exclusion on (e.g. internal ONLINE
-- TRANSFER movements) or whose only tie to a human exclusion decision is an
-- inferred amount+date+name match that must not become a stored money
-- relationship.
--
-- This is a DECISION authority, not evidence: it never counts money, never
-- composes a deposit (bank_deposit_components / deposit_qbo_components remain the
-- evidence planes), and only drives the workbench Not-fundraising
-- classification. One row per bank deposit; delete the row to return the deposit
-- to the open queue.
--
-- Additive DDL only (no data). Idempotent (IF NOT EXISTS). Apply with:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0175_bank_deposit_exclusions.sql

CREATE TABLE IF NOT EXISTS bank_deposit_exclusions (
  id text PRIMARY KEY,
  bank_deposit_id text NOT NULL REFERENCES bank_deposits(id) ON DELETE CASCADE,
  reason staged_payment_exclusion_reason NOT NULL,
  note text,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_deposit_exclusions_bank_deposit_id_uq
  ON bank_deposit_exclusions (bank_deposit_id);

CREATE INDEX IF NOT EXISTS bank_deposit_exclusions_reason_idx
  ON bank_deposit_exclusions (reason);
