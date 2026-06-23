-- Migration 0071: Reimbursable direct/indirect share tag (additive schema only)
--
-- Adds the nullable per-allocation-line classification that distinguishes the
-- DIRECT vs INDIRECT share on a reimbursable grant. Full award/reimbursement
-- amounts are always recorded; DIRECT-tagged allocation lines are EXCLUDED from
-- goal analytics (received, committed both sides, open ask, weighted ask), while
-- untagged (NULL) and indirect both still count. The tag NEVER changes
-- opportunity-status derivation or pledge paid-amount derivation.
--   1. enum  reimbursable_share (direct | indirect)
--   2. col   pledge_allocations.reimbursable_share  (NULLABLE, no default)
--   3. col   gift_allocations.reimbursable_share    (NULLABLE, no default)
--
-- WHY A HAND-APPLIED FILE (not relying on the Publish schema diff alone):
--   drizzle-kit push / the Publish diff can ABORT on a PRE-EXISTING, unrelated
--   drift in the live DB (e.g. opportunities `conditions_met` tri-state), which
--   would skip ALL additive changes -- including these columns. This file
--   applies the additive schema changes idempotently without touching any
--   drifted column. Run it before (or instead of relying on) the Publish diff.
--
-- SAFETY / IDEMPOTENCY:
--   * Guarded with a pg_type enum guard + IF NOT EXISTS columns -- re-running is a no-op.
--   * Purely additive: one enum + two NULLABLE columns. Touches no existing data,
--     drops nothing. Every existing row stays NULL (untagged => still counts).
--
-- Apply with psql -1 (it wraps the whole file in ONE transaction; do NOT add a
-- top-level BEGIN/COMMIT here or it nests and warns):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0071_reimbursable_share.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0071_reimbursable_share.sql   (prod)

-- 1. Enum type ---------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reimbursable_share') THEN
    CREATE TYPE reimbursable_share AS ENUM ('direct', 'indirect');
  END IF;
END
$$;

-- 2. pledge_allocations.reimbursable_share ----------------------------------
ALTER TABLE pledge_allocations
  ADD COLUMN IF NOT EXISTS reimbursable_share reimbursable_share;

-- 3. gift_allocations.reimbursable_share ------------------------------------
ALTER TABLE gift_allocations
  ADD COLUMN IF NOT EXISTS reimbursable_share reimbursable_share;

-- Verification:
--   SELECT unnest(enum_range(NULL::reimbursable_share));   -- Expect: direct, indirect
--
--   SELECT table_name, column_name, udt_name, column_default, is_nullable
--     FROM information_schema.columns
--    WHERE column_name = 'reimbursable_share'
--    ORDER BY table_name;
--   -- Expect 2 rows (gift_allocations, pledge_allocations), both udt_name
--   --   reimbursable_share, is_nullable YES, no column_default.
