CREATE TABLE IF NOT EXISTS calendar_event_archives (
  physical_event_key text PRIMARY KEY,
  archived_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  archived_at timestamptz NOT NULL DEFAULT now()
);
