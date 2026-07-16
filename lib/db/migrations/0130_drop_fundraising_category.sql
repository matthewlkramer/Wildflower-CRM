-- Migration 0130 — Drop the retired `fundraising_category` enum and columns.
--
-- The `loan_or_grant` cutover (migrations 0067/0068/0120) is complete: the app
-- has read and written ONLY `loan_or_grant` for the full prod cycle following
-- migration 0120. The two legacy columns —
--   opportunities_and_pledges.fundraising_category
--   fiscal_year_entity_goals.category
-- — and the backing `fundraising_category` pg enum are now safe to drop.
--
-- IDEMPOTENT: each statement is guarded by IF EXISTS / conditional block so the
-- file can be re-run without error.
--
-- Apply:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0130_drop_fundraising_category.sql

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'opportunities_and_pledges'
      AND column_name  = 'fundraising_category'
  ) THEN
    ALTER TABLE opportunities_and_pledges DROP COLUMN fundraising_category;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'fiscal_year_entity_goals'
      AND column_name  = 'category'
  ) THEN
    ALTER TABLE fiscal_year_entity_goals DROP COLUMN category;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'fundraising_category'
      AND n.nspname  = 'public'
  ) THEN
    DROP TYPE public.fundraising_category;
  END IF;
END $$;
