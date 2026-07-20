-- Delete the duplicate fundable_projects row with name = 'Seed Fund'.
-- The correct "Seed Fund" concept row has a different name in prod
-- ('Seed to Fund Wildflowers'); only the mis-named duplicate is removed.
--
-- Idempotent: safe to re-run — both statements are no-ops if the row is already
-- gone.
-- Applied with: psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--               -f lib/db/migrations/0136_delete_duplicate_seed_fund_row.sql

-- Nullify any gift_allocations FK references to the bad row first.
-- gift_allocations.fundable_project_id is RESTRICT, so the DELETE below would
-- fail if any allocations still point to it.
UPDATE gift_allocations
SET fundable_project_id = NULL
WHERE fundable_project_id IN (
  SELECT id FROM fundable_projects WHERE name = 'Seed Fund'
);

-- Remove the bad row.
DELETE FROM fundable_projects WHERE name = 'Seed Fund';
