-- Migration 0006: Add planning timeframes + fundraising goal to fundable_projects
--
-- Adds five nullable columns powering the dedicated "Fundable projects" page:
--   fundraising_start / fundraising_end / spending_start / spending_end  (date)
--   fundraising_goal                                                     (numeric(14,2))
--
-- All columns are nullable on purpose: existing fundable_projects rows were
-- seeded before these columns existed, and the UI treats a missing
-- fundraising_start/fundraising_goal as "needs to be filled in" rather than an
-- error. No backfill is required.
--
-- ORDER: run this BEFORE (or at the moment of) deploying the new application
-- code. The new code SELECTs/INSERTs these columns; if the code ships first,
-- any read/write touching fundable_projects fails with "column does not exist"
-- until this lands.
--
-- Non-destructive + idempotent: every statement uses ADD COLUMN IF NOT EXISTS,
-- so a second run is a no-op and no existing data is touched.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0006_fundable_project_planning_fields.sql

ALTER TABLE fundable_projects ADD COLUMN IF NOT EXISTS fundraising_start date;
ALTER TABLE fundable_projects ADD COLUMN IF NOT EXISTS fundraising_end   date;
ALTER TABLE fundable_projects ADD COLUMN IF NOT EXISTS spending_start    date;
ALTER TABLE fundable_projects ADD COLUMN IF NOT EXISTS spending_end      date;
ALTER TABLE fundable_projects ADD COLUMN IF NOT EXISTS fundraising_goal  numeric(14,2);
