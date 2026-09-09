-- Adds the durable CRM disposition for calendar events that do not need notes.
-- This is additive and preserves all Google Calendar event evidence.
-- Apply from the repository root:
-- psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0237_meeting_note_dismissals.sql

CREATE TABLE IF NOT EXISTS meeting_note_dismissals (
  id text PRIMARY KEY,
  gcal_event_id text NOT NULL,
  dismissed_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_note_dismissals_gcal_event_uq UNIQUE (gcal_event_id)
);

CREATE INDEX IF NOT EXISTS meeting_note_dismissals_user_idx
  ON meeting_note_dismissals (dismissed_by_user_id);
