-- Migration 0008: Track human confirmation of a staged-payment donor match
--
-- Adds two nullable columns to staged_payments:
--   match_confirmed_by_user_id  text  (FK -> users.id, ON DELETE SET NULL)
--   match_confirmed_at          timestamptz
--
-- These distinguish the three review-queue match states:
--   * unmatched      — match_status = 'unmatched'
--   * system matched — match_status = 'matched' AND match_confirmed_at IS NULL
--   * human approved — match_confirmed_at IS NOT NULL
--
-- They are independent of `status` (which tracks whether the row has been
-- minted into a gift). NULL on every existing row is the correct starting
-- state: rows the auto-matcher already matched read as "system matched" until
-- a human confirms them. No backfill is required.
--
-- ORDER: run this BEFORE (or at the moment of) deploying the new application
-- code. The new code SELECTs/SETs these columns; if the code ships first, any
-- read/write touching staged_payments fails with "column does not exist".
--
-- Non-destructive + idempotent: ADD COLUMN IF NOT EXISTS, and the FK is added
-- inside a guarded DO block that swallows duplicate_object, so a second run is
-- a no-op and no existing data is touched.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0008_staged_payment_match_confirmation.sql

ALTER TABLE staged_payments ADD COLUMN IF NOT EXISTS match_confirmed_by_user_id text;
ALTER TABLE staged_payments ADD COLUMN IF NOT EXISTS match_confirmed_at timestamptz;

DO $$ BEGIN
  ALTER TABLE staged_payments
    ADD CONSTRAINT staged_payments_match_confirmed_by_user_id_users_id_fk
    FOREIGN KEY (match_confirmed_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
