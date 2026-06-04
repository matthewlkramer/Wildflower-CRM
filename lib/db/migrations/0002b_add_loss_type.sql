-- Migration 0002b: Add opportunity loss_type override (supersedes Task #158's
-- "publish with overwrite" cutover)
--
-- Task #158 split the old `status` overload: `status` is now FULLY CALCULATED
-- (stage + payments + loss_type) and `loss_type` is the ONLY user-settable
-- override. dormant/lost used to live directly on `status`; they now live on
-- the new `loss_type` column and `status` merely mirrors them.
--
-- That commit assumed the old wholesale dev->prod overwrite cutover, so no
-- idempotent migration ever shipped. Prod now holds live data and cannot be
-- overwritten, so this additive, idempotent file delivers the same end state:
--   * creates the opportunity_loss_type enum (dormant, lost)   [guarded]
--   * adds opportunities_and_pledges.loss_type                 [IF NOT EXISTS]
--   * backfills loss_type FROM EACH ROW'S OWN CURRENT status
--     where status IN ('dormant','lost') and loss_type is still null
--
-- The backfill reads PROD'S OWN state — it does not hardcode dev's row count.
-- `status` keeps its dormant/lost enum members (it must, since status mirrors
-- loss_type), so nothing about the status enum changes here.
--
-- ORDER: run this FIRST in the sync batch — BEFORE 0003/0004. 0004
-- (reclassify verbal_confirmation) reads o.loss_type, so the column must exist
-- before it runs. Safe to land before deploying the new application code: the
-- column is additive and the new code expects it to be present.
--
-- Idempotent: guarded CREATE TYPE, ADD COLUMN IF NOT EXISTS, and the backfill
-- only touches rows whose loss_type is still NULL while status is dormant/lost,
-- so a second run matches zero rows.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0002b_add_loss_type.sql

-- 1. Create the enum if it does not already exist.
DO $$
BEGIN
  IF to_regtype('opportunity_loss_type') IS NULL THEN
    CREATE TYPE opportunity_loss_type AS ENUM ('dormant', 'lost');
  END IF;
END $$;

-- 2. Add the nullable override column.
ALTER TABLE opportunities_and_pledges
  ADD COLUMN IF NOT EXISTS loss_type opportunity_loss_type;

-- 3. Backfill the override from each row's CURRENT status. status keeps the
--    dormant/lost members, so the cast is value-preserving. Only rows that are
--    currently dormant/lost AND still have a null override are touched, so a
--    re-run is a no-op.
UPDATE opportunities_and_pledges
SET loss_type = status::text::opportunity_loss_type,
    updated_at = now()
WHERE status::text IN ('dormant', 'lost')
  AND loss_type IS NULL;

-- Pre-flight check (read-only) — rows that WILL be backfilled:
--   SELECT count(*) FROM opportunities_and_pledges
--   WHERE status::text IN ('dormant','lost') AND loss_type IS NULL;
--
-- Post-apply verification — every dormant/lost row now carries a matching
-- override (expect ZERO rows):
--   SELECT id, status, loss_type FROM opportunities_and_pledges
--   WHERE status::text IN ('dormant','lost')
--     AND (loss_type IS NULL OR loss_type::text <> status::text);
