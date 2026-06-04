-- Migration 0003: Rename opportunity stage verbal_commitment -> verbal_confirmation
--
-- Renames the stored enum value on opportunity_stage. The label shown to
-- users ("Verbal confirmation") is driven entirely by the frontend, so only
-- the enum value changes here.
--
-- ORDER: run this BEFORE (or at the moment of) deploying the new application
-- code. The new code references the value `verbal_confirmation`; if the code
-- ships first, any read/write touching this stage will fail until the rename
-- lands. A bare ALTER TYPE ... RENAME VALUE is itself transactional and fast
-- (catalog-only, no table rewrite).
--
-- Idempotent: the rename only runs when the old label still exists, so a
-- second run is a no-op.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0003_rename_verbal_confirmation.sql

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'opportunity_stage'
      AND e.enumlabel = 'verbal_commitment'
  ) THEN
    ALTER TYPE opportunity_stage RENAME VALUE 'verbal_commitment' TO 'verbal_confirmation';
  END IF;
END $$;
