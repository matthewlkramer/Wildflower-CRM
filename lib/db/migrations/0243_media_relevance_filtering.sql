-- Media mention relevance filtering.
--
-- Additive and idempotent: existing rows remain visible until the separate,
-- manually invoked backfill evaluates them.
--
-- Apply manually (staging first):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0243_media_relevance_filtering.sql

ALTER TABLE media_mentions
  ADD COLUMN IF NOT EXISTS canonical_url text,
  ADD COLUMN IF NOT EXISTS relevance_score real,
  ADD COLUMN IF NOT EXISTS is_filtered boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS media_mentions_is_filtered_idx
  ON media_mentions (is_filtered);
