-- Distinguish a calendar bootstrap that is advancing from one replaying the
-- same failed page. Existing rows begin at zero; subsequent sync runs measure
-- progress from their saved page cursor.
-- Safe to rerun: only adds a defaulted column if missing.
-- Apply from the repo root after Publish:
-- psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0270_calendar_sync_progress.sql
ALTER TABLE calendar_sync_state
  ADD COLUMN IF NOT EXISTS no_progress_runs integer NOT NULL DEFAULT 0;
