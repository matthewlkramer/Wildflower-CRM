-- Add user provenance to cleanup flags. Existing migration-seeded rows are
-- intentionally left NULL and render as System in the review queue.

ALTER TABLE cleanup_queue
  ADD COLUMN IF NOT EXISTS flagged_by_user_id text;

CREATE INDEX IF NOT EXISTS cleanup_queue_flagged_by_user_idx
  ON cleanup_queue(flagged_by_user_id);
