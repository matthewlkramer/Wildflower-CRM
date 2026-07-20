-- Delete fiscal years FY2036 and later (fy2036–fy2050).
-- These were seeded speculatively and have no real data attached.
--
-- The LIKE 'fy%' guard restricts the filter to canonical FY slugs and avoids
-- touching any non-standard test rows that happen to sort after 'fy2036'.
--
-- FK safety:
--   fiscal_year_entity_goals.fiscal_year_id  → CASCADE  (auto-deleted below)
--   gift_allocations.grant_year              → RESTRICT (DELETE fails if any
--   pledge_allocations.grant_year            → RESTRICT  allocation references
--                                                         a deleted FY row —
--                                                         safe guard for prod)
--
-- Idempotent: safe to re-run; both statements are no-ops if the rows are
-- already gone.
-- Applied with: psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--               -f lib/db/migrations/0137_delete_future_fiscal_years.sql

-- Remove per-entity goals first (CASCADE would handle this automatically, but
-- explicit deletion is cleaner and avoids any FK ordering surprises).
DELETE FROM fiscal_year_entity_goals
WHERE fiscal_year_id LIKE 'fy%'
  AND fiscal_year_id >= 'fy2036';

-- Remove the fiscal year rows.
-- The RESTRICT FKs on gift_allocations and pledge_allocations act as a safety
-- net: if any allocation somehow references a row being deleted, the statement
-- fails loudly rather than silently corrupting data.
DELETE FROM fiscal_years
WHERE id LIKE 'fy%'
  AND id >= 'fy2036';
