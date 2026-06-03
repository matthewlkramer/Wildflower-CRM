-- Migration: Consolidate conditional field on opportunities_and_pledges
--
-- Replaces the redundant `is_conditional` boolean with a new
-- `conditional_unspecified` enum value on the existing
-- `opportunity_conditional` enum.
--
-- Safe to re-run: all statements are guarded with IF NOT EXISTS /
-- DO NOTHING / IF EXISTS so the script is idempotent.

-- Step 1: Add the new enum value (IF NOT EXISTS is supported in PG 9.6+)
ALTER TYPE opportunity_conditional ADD VALUE IF NOT EXISTS 'conditional_unspecified';

-- Step 2: Backfill rows that had is_conditional=true but no enum value set.
--         Only runs when the column still exists, so re-runs are no-ops.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'opportunities_and_pledges'
      AND column_name  = 'is_conditional'
  ) THEN
    UPDATE opportunities_and_pledges
    SET conditional = 'conditional_unspecified'
    WHERE is_conditional = true
      AND conditional IS NULL;
  END IF;
END $$;

-- Step 3: Drop the now-redundant boolean column.
ALTER TABLE opportunities_and_pledges
  DROP COLUMN IF EXISTS is_conditional;
