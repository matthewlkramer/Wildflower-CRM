-- Structured per-person follow-up and an append-only, attributed trip thread.

ALTER TABLE trip_visit_candidates
  ADD COLUMN IF NOT EXISTS next_step text,
  ADD COLUMN IF NOT EXISTS planning_updated_by_user_id text
    REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS planning_updated_at timestamptz;

CREATE TABLE IF NOT EXISTS trip_plan_comments (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES trip_plans(id) ON DELETE CASCADE,
  author_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body text NOT NULL CONSTRAINT trip_plan_comments_body_nonblank
    CHECK (length(trim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_plan_comments_trip_created_idx
  ON trip_plan_comments(trip_id, created_at);
