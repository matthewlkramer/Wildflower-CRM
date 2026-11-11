CREATE TABLE IF NOT EXISTS zoom_transcript_jobs (
  uuid text PRIMARY KEY,
  meeting_id text NOT NULL,
  host_id text NOT NULL,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  meeting_type integer NOT NULL,
  target jsonb,
  ended_at timestamptz,
  transcript_ready_at timestamptz,
  capture_requested_at timestamptz,
  next_attempt_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  finished_at timestamptz,
  outcome text
);

CREATE INDEX IF NOT EXISTS zoom_transcript_jobs_due_idx
  ON zoom_transcript_jobs (next_attempt_at);
