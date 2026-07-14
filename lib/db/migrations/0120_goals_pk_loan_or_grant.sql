-- 0120 — Swap fiscal_year_entity_goals' composite PK from the legacy
-- (fiscal_year_id, entity_id, category) to the authoritative
-- (fiscal_year_id, entity_id, loan_or_grant).
--
-- Why: the loan_or_grant cutover stops writing the legacy `category` column.
-- With the old PK still keyed on category, a second goal for the same
-- (fy, entity) would collide on category's 'revenue' default, so the PK must
-- move to the authoritative flag. Parity (category ↔ loan_or_grant 1:1) was
-- verified clean on prod 2026-07-13, so the new key is guaranteed unique.
--
-- `category` stays physical (NOT NULL DEFAULT 'revenue', @deprecated, frozen)
-- for the deprecate-then-drop window. No data is modified.
--
-- Idempotent: safe to re-run; each step no-ops when already applied.
-- Apply (from repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0120_goals_pk_loan_or_grant.sql

DO $$
BEGIN
  -- Precondition: the new key must be unique before it can become the PK.
  -- With clean parity this never fires (category ↔ loan_or_grant are 1:1).
  IF EXISTS (
    SELECT 1
    FROM fiscal_year_entity_goals
    GROUP BY fiscal_year_id, entity_id, loan_or_grant
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'fiscal_year_entity_goals: duplicate (fiscal_year_id, entity_id, loan_or_grant) rows — parity drift; resolve before swapping the PK';
  END IF;

  -- Drop the legacy PK (no-op when already dropped).
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fiscal_year_entity_goals_fiscal_year_id_entity_id_category_pk'
      AND conrelid = 'fiscal_year_entity_goals'::regclass
  ) THEN
    ALTER TABLE fiscal_year_entity_goals
      DROP CONSTRAINT fiscal_year_entity_goals_fiscal_year_id_entity_id_category_pk;
  END IF;

  -- Add the authoritative PK (no-op when already present). Name matches the
  -- explicit name in lib/db/src/schema/fiscalYearEntityGoals.ts so drizzle
  -- push / Publish see a converged state.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fy_entity_goals_fy_entity_loan_or_grant_pk'
      AND conrelid = 'fiscal_year_entity_goals'::regclass
  ) THEN
    ALTER TABLE fiscal_year_entity_goals
      ADD CONSTRAINT fy_entity_goals_fy_entity_loan_or_grant_pk
      PRIMARY KEY (fiscal_year_id, entity_id, loan_or_grant);
  END IF;
END $$;
