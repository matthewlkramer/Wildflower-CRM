-- Migration 0009: Add soft-delete tombstone to media_mentions
--
-- Adds one nullable-default column powering durable "delete" of a media
-- mention from the activity feed:
--   dismissed  boolean NOT NULL DEFAULT false
--
-- WHY: "Deleting" a media mention used to be a hard DELETE. GDELT ingestion
-- dedupes only by article URL (ON CONFLICT (url)), so the very next sweep
-- re-inserted the exact same article and the mention reappeared. We now mark
-- the row `dismissed = true` instead of removing it: the URL stays on record
-- as a tombstone, the list endpoint excludes dismissed rows, and the ingest
-- upsert's DO UPDATE guard refuses to re-link or un-dismiss a dismissed URL.
-- Dismissal is GLOBAL per article (per url), not per linked entity.
--
-- ORDER: run this BEFORE (or at the moment of) deploying the new application
-- code. The DELETE handler and list endpoint SELECT/UPDATE this column; if the
-- code ships first, any read/delete touching media_mentions fails with
-- "column dismissed does not exist" until this lands.
--
-- Non-destructive + idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX
-- IF NOT EXISTS, so a second run is a no-op and no existing data is touched.
-- Existing rows default to dismissed = false (i.e. still visible), which is the
-- correct, conservative behavior — nothing is hidden by the migration itself.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0009_media_mention_dismissed.sql

ALTER TABLE media_mentions ADD COLUMN IF NOT EXISTS dismissed boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS media_mentions_dismissed_idx ON media_mentions(dismissed);

-- Verification:
--   SELECT count(*) FILTER (WHERE dismissed) AS dismissed_rows,
--          count(*)                          AS total_rows
--   FROM media_mentions;  -- dismissed_rows should be 0 immediately after this migration
