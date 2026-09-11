-- Media mention relevance filtering.
--
-- Additive and idempotent: existing rows remain visible until the separate,
-- manually invoked backfill evaluates them. Production schema changes are
-- applied through the reviewed Replit Publish plan, never direct psql.

ALTER TABLE media_mentions
  ADD COLUMN IF NOT EXISTS canonical_url text,
  ADD COLUMN IF NOT EXISTS relevance_score real,
  ADD COLUMN IF NOT EXISTS is_filtered boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS media_mentions_is_filtered_idx
  ON media_mentions (is_filtered);