-- Migration 0095: Physically DROP the fully-deprecated Task #449 restriction /
-- revenue-coding-snapshot columns from gift_allocations and pledge_allocations.
--
-- These were superseded by:
--   * the three-axis restriction taxonomy (regional/usage/time_restriction_type,
--     RestrictionType axis) — replaces the coarse formal_* booleans and the old
--     restriction_type enum column, and
--   * the revenue-coding snapshot moving to staged_payments (the allocation still
--     GENERATES a coding preview on demand from its scope; it no longer persists
--     one).
--
-- DROPS (two tables ONLY):
--   gift_allocations:   formal_regional_restriction, formal_fund_use_restriction,
--                       restriction_type, restriction_evidence, deferred_revenue,
--                       deferred_revenue_reason, object_code, object_code_override,
--                       revenue_location, revenue_location_override, revenue_class,
--                       revenue_class_override, coding_flags
--   pledge_allocations: formally_restricted, restriction_type, restriction_evidence,
--                       deferred_revenue, deferred_revenue_reason, object_code,
--                       object_code_override, revenue_location,
--                       revenue_location_override, revenue_class,
--                       revenue_class_override, coding_flags
--
-- DO NOT TOUCH staged_payments: the IDENTICALLY-NAMED coding columns there
-- (object_code, revenue_location, revenue_class, coding_flags, deferred_revenue,
-- deferred_revenue_reason, …) are LIVE — read/written by reconciliation/cards.ts,
-- quickbooks/actions.ts and the workbench coding form. This drop is strictly the
-- two allocation tables.
--
-- ENUM TYPES:
--   * deferred_revenue enum STAYS — staged_payments.deferred_revenue still uses it.
--   * restriction_type enum becomes orphaned after this drop (nothing else uses
--     it). Intentionally NOT dropped here — low value and a bare DROP TYPE would
--     fail if any dependency remains. Left as a harmless unused type; retire it in
--     a later dedicated migration only after re-confirming zero references.
--
-- SAFE TO DROP — verified read-only: no app code reads or writes these columns on
-- the allocation tables. They survived only in the Drizzle schema + the generated
-- OpenAPI/Zod (both removed by this task's code). The lone raw-SQL reader
-- (reconciliation/cards.ts resolvedGiftAllocations) was updated in the same task
-- to read the live regional/usage/time_restriction_type columns instead.
--
-- No indexes, FKs, or enum types depend on these columns.
--
-- IF EXISTS -> idempotent / re-runnable (a second run is a no-op).
--
-- ORDERING (prod) — Publish FIRST, THEN this SQL (same direction as 0094). The
-- columns are no longer WRITTEN, but the currently-deployed prod build still
-- SELECTs them: they remain in the Drizzle schema and select()/getTableColumns
-- emit every schema column (the response is scrubbed only AFTER the read).
-- Dropping them before the schema-removal code deploys would 500 every gift /
-- pledge allocation read. Publish diffs dev-DB vs prod-DB (NOT the schema source),
-- so keep BOTH DBs holding these columns THROUGH Publish (do NOT drop dev alone
-- first, or Publish would see a prod-only column and propose a destructive prod
-- drop that aborts the whole diff). Only AFTER the new code is live in prod apply
-- this file to prod AND dev.
--
-- Apply with psql -1 (wraps the file in ONE transaction; do NOT add BEGIN/COMMIT):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0095_drop_deprecated_allocation_cols.sql   (prod)
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0095_drop_deprecated_allocation_cols.sql   (dev)

ALTER TABLE gift_allocations
  DROP COLUMN IF EXISTS formal_regional_restriction,
  DROP COLUMN IF EXISTS formal_fund_use_restriction,
  DROP COLUMN IF EXISTS restriction_type,
  DROP COLUMN IF EXISTS restriction_evidence,
  DROP COLUMN IF EXISTS deferred_revenue,
  DROP COLUMN IF EXISTS deferred_revenue_reason,
  DROP COLUMN IF EXISTS object_code,
  DROP COLUMN IF EXISTS object_code_override,
  DROP COLUMN IF EXISTS revenue_location,
  DROP COLUMN IF EXISTS revenue_location_override,
  DROP COLUMN IF EXISTS revenue_class,
  DROP COLUMN IF EXISTS revenue_class_override,
  DROP COLUMN IF EXISTS coding_flags;

ALTER TABLE pledge_allocations
  DROP COLUMN IF EXISTS formally_restricted,
  DROP COLUMN IF EXISTS restriction_type,
  DROP COLUMN IF EXISTS restriction_evidence,
  DROP COLUMN IF EXISTS deferred_revenue,
  DROP COLUMN IF EXISTS deferred_revenue_reason,
  DROP COLUMN IF EXISTS object_code,
  DROP COLUMN IF EXISTS object_code_override,
  DROP COLUMN IF EXISTS revenue_location,
  DROP COLUMN IF EXISTS revenue_location_override,
  DROP COLUMN IF EXISTS revenue_class,
  DROP COLUMN IF EXISTS revenue_class_override,
  DROP COLUMN IF EXISTS coding_flags;

-- Verification (run by hand AFTER applying) -----------------------------------
--   -- All dropped columns gone (expect zero rows):
--   SELECT table_name, column_name FROM information_schema.columns
--   WHERE (table_name = 'gift_allocations' AND column_name IN (
--           'formal_regional_restriction','formal_fund_use_restriction',
--           'restriction_type','restriction_evidence','deferred_revenue',
--           'deferred_revenue_reason','object_code','object_code_override',
--           'revenue_location','revenue_location_override','revenue_class',
--           'revenue_class_override','coding_flags'))
--      OR (table_name = 'pledge_allocations' AND column_name IN (
--           'formally_restricted','restriction_type','restriction_evidence',
--           'deferred_revenue','deferred_revenue_reason','object_code',
--           'object_code_override','revenue_location','revenue_location_override',
--           'revenue_class','revenue_class_override','coding_flags'));
--
--   -- staged_payments coding columns UNTOUCHED (expect all present):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'staged_payments'
--     AND column_name IN ('object_code','revenue_location','revenue_class',
--                         'coding_flags','deferred_revenue','deferred_revenue_reason')
--   ORDER BY column_name;
