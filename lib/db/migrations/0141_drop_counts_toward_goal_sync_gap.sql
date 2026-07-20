-- Migration 0141: Physically DROP the three retired columns deferred by migration 0080
-- (Task #715). All three were deprecated and their reads moved to gift_allocations in
-- migration 0080; the header/staged copies were intentionally kept @deprecated in the
-- Drizzle schema until this reviewed DROP lands.
--
-- DROPS:
--   gifts_and_payments.counts_toward_goal  — goal-counting flag now lives ONLY on
--                                            gift_allocations.counts_toward_goal.
--                                            Backfilled by 0080 (monotonic false-push).
--   staged_payments.counts_toward_goal     — same signal on the staged side; retired
--                                            alongside the gifts header copy.
--   staged_payments.sync_gap               — annotation added in 0074 but never shipped
--                                            to any UI or API; retired in 0080 as well.
--
-- SAFE TO RE-RUN (all statements use IF EXISTS).
--
-- ORDERING:
--   No Publish step is required before applying this file. The application code has
--   not read or written these columns since migration 0080 backfilled the signal onto
--   gift_allocations. Both columns are already absent from the Drizzle schema (removed
--   from giftsAndPayments.ts / stagedPayments.ts), so the dev DB no longer holds them.
--   Apply this file to prod to bring prod into sync:
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0141_drop_counts_toward_goal_sync_gap.sql
--
--   (The dev DB is already clean; running against dev is a harmless no-op.)
--
-- Run with `-1` (psql wraps the file in ONE transaction). Do NOT add BEGIN/COMMIT
-- inside the file — `-1` already provides the single-transaction guarantee.

-- Drop three retired columns across two tables
ALTER TABLE gifts_and_payments
  DROP COLUMN IF EXISTS counts_toward_goal;

ALTER TABLE staged_payments
  DROP COLUMN IF EXISTS counts_toward_goal,
  DROP COLUMN IF EXISTS sync_gap;

-- Verification (run by hand AFTER applying) -------------------------------------
--   -- All three columns gone (expect ZERO rows):
--   SELECT table_name, column_name
--   FROM information_schema.columns
--   WHERE table_name IN ('gifts_and_payments', 'staged_payments')
--     AND column_name IN ('counts_toward_goal', 'sync_gap')
--   ORDER BY table_name, column_name;
--
--   -- counts_toward_goal still lives on the allocations (expect a healthy count):
--   SELECT count(*) FROM gift_allocations WHERE counts_toward_goal = true;
