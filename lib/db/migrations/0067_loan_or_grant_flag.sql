-- Migration 0067: Authoritative loan_or_grant flag (additive schema only)
--
-- Adds the SINGLE authoritative loan-vs-grant classification that will replace
-- the two scattered legacy signals (opportunities.fundraising_category and
-- gifts.type='loan_fund_investment'). PHASE 1 = additive only: the column is
-- dual-written alongside the legacy signals but nothing READS it yet.
--   1. enum  loan_or_grant (loan | grant)
--   2. col   gifts_and_payments.loan_or_grant         (NOT NULL DEFAULT 'grant')
--   3. col   opportunities_and_pledges.loan_or_grant  (NOT NULL DEFAULT 'grant')
--   4. col   fiscal_year_entity_goals.loan_or_grant   (NOT NULL DEFAULT 'grant')
--
-- Semantic map (1:1): loan_capital / loan_fund_investment -> 'loan';
--   revenue / every other gift type -> 'grant'. NOTE: 'grant' = ALL non-loan
--   money (individual donations, foundation grants, earned revenue, ...), NOT
--   literally only grants.
--
-- WHY A HAND-APPLIED FILE (not relying on the Publish schema diff alone):
--   drizzle-kit push / the Publish diff currently ABORT on a PRE-EXISTING,
--   unrelated drift in this DB (opportunities `conditions_met` tri-state), which
--   would skip ALL additive changes -- including these columns. This file
--   applies the additive schema changes idempotently without touching the
--   drifted column. Run it before (or instead of relying on) the Publish diff.
--
-- SAFETY / IDEMPOTENCY:
--   * Guarded with a pg_type enum guard + IF NOT EXISTS columns -- re-running is a no-op.
--   * Purely additive: one enum + three columns. Touches no existing data, drops nothing.
--   * Every existing row lands at the default 'grant'; run the 0068 backfill
--     afterwards to set the real loan rows (loan_capital / loan_fund_investment)
--     and the Gary Community Investments data correction.
--
-- Apply with psql -1 (it wraps the whole file in ONE transaction; do NOT add a
-- top-level BEGIN/COMMIT here or it nests and warns):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0067_loan_or_grant_flag.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0067_loan_or_grant_flag.sql   (prod)

-- 1. Enum type ---------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'loan_or_grant') THEN
    CREATE TYPE loan_or_grant AS ENUM ('loan', 'grant');
  END IF;
END
$$;

-- 2. gifts_and_payments.loan_or_grant ---------------------------------------
ALTER TABLE gifts_and_payments
  ADD COLUMN IF NOT EXISTS loan_or_grant loan_or_grant NOT NULL DEFAULT 'grant';

-- 3. opportunities_and_pledges.loan_or_grant --------------------------------
ALTER TABLE opportunities_and_pledges
  ADD COLUMN IF NOT EXISTS loan_or_grant loan_or_grant NOT NULL DEFAULT 'grant';

-- 4. fiscal_year_entity_goals.loan_or_grant ---------------------------------
ALTER TABLE fiscal_year_entity_goals
  ADD COLUMN IF NOT EXISTS loan_or_grant loan_or_grant NOT NULL DEFAULT 'grant';

-- Verification:
--   SELECT unnest(enum_range(NULL::loan_or_grant));   -- Expect: loan, grant
--
--   SELECT table_name, column_name, udt_name, column_default, is_nullable
--     FROM information_schema.columns
--    WHERE column_name = 'loan_or_grant'
--    ORDER BY table_name;
--   -- Expect 3 rows (fiscal_year_entity_goals, gifts_and_payments,
--   --   opportunities_and_pledges), all udt_name loan_or_grant, NOT NULL,
--   --   DEFAULT 'grant'::loan_or_grant.
