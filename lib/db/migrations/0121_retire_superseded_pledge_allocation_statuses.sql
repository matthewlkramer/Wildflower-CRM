-- 0120: Retire the superseded pledge-allocation statuses (Task #665).
--
-- The `superseded` / `superseded_by_pledge` / `superseded_by_gift` values of
-- the `pledge_allocation_status` enum are retired: removed from the OpenAPI
-- contract (new writes are rejected with 400) and from the allocation-editor
-- dropdown. This migration remaps the only historical rows carrying them —
-- 4 rows on two long-closed opportunities — to `abandoned`.
--
-- Expected prod rows (verified 2026-07-13; both parent opps are cash_in /
-- stage=complete, so no rollup is affected — the only allocation-status-
-- filtered read, /projections-by-fy-entity, requires the parent opp to be
-- status='open' AND already excluded both superseded and abandoned rows):
--   recPU7DLiO1By8jaw      superseded_by_pledge  Chan Zuckerberg Initiative fy16-17
--   recnykefgRItfM9wP      superseded_by_pledge  Chan Zuckerberg Initiative fy16-17
--   h17sjkVVYjdiDMMj4F8Zc  superseded_by_gift    SPP FY20
--   Sm6oT5Jmuz8-bRwi4q69a  superseded_by_gift    SPP FY20
--
-- The three enum values stay in the pg type (removing a pg enum value needs a
-- full type rebuild — deliberately out of scope), so this file is a pure data
-- remap: idempotent, non-destructive (amounts/scope untouched), safe to re-run.
-- The WHERE matches by status (not just id) so any unexpected stragglers are
-- also caught; the id list documents the known rows.
--
-- Apply (from the repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0121_retire_superseded_pledge_allocation_statuses.sql

UPDATE pledge_allocations
SET status = 'abandoned',
    updated_at = now()
WHERE status IN ('superseded', 'superseded_by_pledge', 'superseded_by_gift');

-- Verify: expect 0 rows.
SELECT id, status
FROM pledge_allocations
WHERE status IN ('superseded', 'superseded_by_pledge', 'superseded_by_gift');
