-- Migration 0061: Gift ↔ QuickBooks tie status + off-books fiscal-sponsor flag
--
-- Adds the schema artifacts behind the "Anchor gifts to QuickBooks / flag
-- off-books gifts" feature (INV-2/3/10):
--   1. enum  gift_quickbooks_tie (exempt | tied | amount_mismatch | missing)
--   2. col   gifts_and_payments.off_books_fiscal_sponsor  (bool, default false)
--   3. col   gifts_and_payments.quickbooks_tie_status     (enum, default 'missing')
--   4. index gifts_and_payments_quickbooks_tie_status_idx
--
-- WHY A HAND-APPLIED FILE (not relying on the Publish schema diff alone):
--   drizzle-kit push currently ABORTS on a PRE-EXISTING, unrelated drift in
--   this DB (opportunities `conditions_met` tri-state), which would skip ALL
--   additive changes — including these columns. This file applies the additive
--   schema changes idempotently without touching the drifted column. Run it
--   before (or instead of relying on) the Publish diff for these objects.
--
-- SAFETY / IDEMPOTENCY:
--   * Guarded with IF NOT EXISTS / DO-block enum guards — re-running is a no-op.
--   * Purely additive: creates one enum + two columns + one index. Touches no
--     existing data and drops nothing.
--   * `quickbooks_tie_status` lands at the default 'missing' for every existing
--     gift; run the backfill afterwards to derive the real status:
--       pnpm --filter @workspace/api-server run backfill:gift-qb-tie
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0061_gift_quickbooks_tie.sql

BEGIN;

-- 1. Enum type ---------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gift_quickbooks_tie') THEN
    CREATE TYPE gift_quickbooks_tie AS ENUM (
      'exempt',
      'tied',
      'amount_mismatch',
      'missing'
    );
  END IF;
END
$$;

-- 2. off_books_fiscal_sponsor column ----------------------------------------
ALTER TABLE gifts_and_payments
  ADD COLUMN IF NOT EXISTS off_books_fiscal_sponsor boolean NOT NULL DEFAULT false;

-- 3. quickbooks_tie_status column -------------------------------------------
ALTER TABLE gifts_and_payments
  ADD COLUMN IF NOT EXISTS quickbooks_tie_status gift_quickbooks_tie
    NOT NULL DEFAULT 'missing';

-- 4. index ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS gifts_and_payments_quickbooks_tie_status_idx
  ON gifts_and_payments (quickbooks_tie_status);

-- Verification:
--   SELECT column_name, data_type, column_default, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'gifts_and_payments'
--      AND column_name IN ('off_books_fiscal_sponsor', 'quickbooks_tie_status')
--    ORDER BY column_name;
--   -- Expect both columns NOT NULL with the defaults above.
--
--   SELECT unnest(enum_range(NULL::gift_quickbooks_tie));
--   -- Expect: exempt, tied, amount_mismatch, missing.

COMMIT;
