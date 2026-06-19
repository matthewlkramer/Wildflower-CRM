-- Migration 0051: Fundraising category dimension (revenue vs loan_capital)
--
-- Makes loan-fund capital a first-class fundraising category running parallel to
-- revenue across analytics (dashboard, projections, per-FY/entity goals). Loan
-- capital = principal investments: `loan_fund_investment` gifts (already typed,
-- no schema change needed) + opportunities/pledges newly flagged as loan-capital
-- commitments. Everything else stays revenue.
--
-- All changes are NON-DESTRUCTIVE and idempotent:
--   1. CREATE TYPE fundraising_category ENUM ('revenue','loan_capital') — guarded.
--   2. opportunities_and_pledges.fundraising_category — NOT NULL DEFAULT 'revenue'.
--      Adding with a default backfills every existing row to 'revenue' in one step.
--   3. fiscal_year_entity_goals.category — NOT NULL DEFAULT 'revenue' (same backfill),
--      then widen the composite PRIMARY KEY from (fiscal_year_id, entity_id) to
--      (fiscal_year_id, entity_id, category). Existing rows were unique on the old
--      pair, so they stay unique under the new triple (all category='revenue').
--
-- ORDERING / APPLY:
--   The new ENUM type, the two columns, and the index/PK reach a fresh schema via
--   the normal Publish (drizzle) diff. This file is the reviewed, idempotent path
--   for applying the same change to a live database where the PK widening must be
--   done deliberately rather than left to an interactive push. Safe to run before
--   OR after a Publish, and safe to re-run.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0051_fundraising_category_dimension.sql

-- 1. Enum type (guarded — CREATE TYPE has no IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'fundraising_category' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.fundraising_category AS ENUM ('revenue', 'loan_capital');
  END IF;
END $$;

-- 2. Opportunity/pledge category. NOT NULL DEFAULT 'revenue' backfills existing rows.
ALTER TABLE opportunities_and_pledges
  ADD COLUMN IF NOT EXISTS fundraising_category public.fundraising_category
  NOT NULL DEFAULT 'revenue';

-- 3a. Goal category column. NOT NULL DEFAULT 'revenue' backfills existing rows.
ALTER TABLE fiscal_year_entity_goals
  ADD COLUMN IF NOT EXISTS category public.fundraising_category
  NOT NULL DEFAULT 'revenue';

-- 3b. Widen the goals PRIMARY KEY to include category (idempotent — only acts
--     when the current PK has fewer than 3 columns).
DO $$
DECLARE
  pk_name text;
  pk_cols int;
BEGIN
  SELECT c.conname, array_length(c.conkey, 1)
    INTO pk_name, pk_cols
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE t.relname = 'fiscal_year_entity_goals'
     AND n.nspname = 'public'
     AND c.contype = 'p';

  IF pk_name IS NULL THEN
    ALTER TABLE fiscal_year_entity_goals
      ADD CONSTRAINT fiscal_year_entity_goals_fiscal_year_id_entity_id_category_pk
      PRIMARY KEY (fiscal_year_id, entity_id, category);
  ELSIF pk_cols < 3 THEN
    EXECUTE format('ALTER TABLE fiscal_year_entity_goals DROP CONSTRAINT %I', pk_name);
    ALTER TABLE fiscal_year_entity_goals
      ADD CONSTRAINT fiscal_year_entity_goals_fiscal_year_id_entity_id_category_pk
      PRIMARY KEY (fiscal_year_id, entity_id, category);
  END IF;
END $$;

-- Report post-state for the operator (non-aborting).
DO $$
DECLARE
  n_opp_revenue int;
  n_goal_revenue int;
  pk_cols int;
BEGIN
  SELECT count(*) INTO n_opp_revenue
    FROM opportunities_and_pledges WHERE fundraising_category = 'revenue';
  SELECT count(*) INTO n_goal_revenue
    FROM fiscal_year_entity_goals WHERE category = 'revenue';
  SELECT array_length(c.conkey, 1) INTO pk_cols
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'fiscal_year_entity_goals' AND c.contype = 'p';
  RAISE NOTICE '0051: opps category=revenue=%, goals category=revenue=%, goals PK columns=% (expect 3)',
    n_opp_revenue, n_goal_revenue, pk_cols;
END $$;
