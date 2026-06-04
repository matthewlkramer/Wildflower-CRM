-- Migration 0014: Track consecutive no-progress Gmail sync runs (stall detection)
--
-- Adds email_sync_state.no_progress_runs, a counter the per-mailbox Gmail sync
-- worker bumps each run that finishes with errors (its pagination cursor /
-- last_history_id is deliberately held instead of advanced) or throws, and
-- resets to 0 on any clean run — including a quiet idle mailbox with no new
-- mail. A sustained non-zero value therefore isolates genuine stall conditions
-- (a transient failure that never clears, a wedged message, repeated 5xx /
-- network errors) from healthy inboxes, and the admin sync-health panel flags a
-- mailbox as "stuck" once the counter crosses its threshold.
--
-- NOT NULL with a server default of 0 so existing rows backfill to 0 (treated
-- as healthy) without a separate UPDATE.
--
-- ORDER: run this BEFORE (or at the moment of) deploying the new application
-- code. The new code SELECTs and writes no_progress_runs on every sync run and
-- in the admin status query; if the code ships first, those statements fail
-- with "column does not exist" until this lands.
--
-- Non-destructive + idempotent: ADD COLUMN IF NOT EXISTS, so a second run is a
-- no-op and no existing data is touched.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0014_email_sync_no_progress_runs.sql

ALTER TABLE email_sync_state
  ADD COLUMN IF NOT EXISTS no_progress_runs integer NOT NULL DEFAULT 0;
