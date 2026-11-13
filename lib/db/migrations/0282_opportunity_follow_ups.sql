ALTER TABLE meeting_notes ADD COLUMN IF NOT EXISTS follow_up_suggestions jsonb;

CREATE TABLE IF NOT EXISTS opportunity_follow_ups (
  id text PRIMARY KEY,
  opportunity_id text NOT NULL REFERENCES opportunities_and_pledges(id) ON DELETE CASCADE,
  meeting_note_id text REFERENCES meeting_notes(id) ON DELETE SET NULL,
  suggestion_key text,
  kind text NOT NULL,
  title text NOT NULL,
  owner_name text,
  point_person_id text REFERENCES users(id) ON DELETE SET NULL,
  evidence_email_id text REFERENCES email_messages(id) ON DELETE SET NULL,
  evidence_url text,
  evidence_note text,
  read_status text,
  external_due_date date,
  dependency_id text REFERENCES opportunity_follow_ups(id),
  check_in_days integer NOT NULL DEFAULT 14,
  check_in_on date,
  sent_on date,
  resolved_on date,
  update_email_id text REFERENCES email_messages(id) ON DELETE SET NULL,
  reviewed_emails_through timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunity_follow_ups_kind_ck CHECK (kind IN ('ours', 'waiting', 'shared')),
  CONSTRAINT opportunity_follow_ups_read_status_ck CHECK (read_status IN ('unread', 'read', 'unknown')),
  CONSTRAINT opportunity_follow_ups_check_in_days_ck CHECK (check_in_days BETWEEN 1 AND 365)
);
CREATE INDEX IF NOT EXISTS opportunity_follow_ups_opportunity_idx ON opportunity_follow_ups(opportunity_id);
CREATE INDEX IF NOT EXISTS opportunity_follow_ups_check_in_idx ON opportunity_follow_ups(check_in_on)
  WHERE kind = 'waiting' AND resolved_on IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS opportunity_follow_ups_suggestion_uq ON opportunity_follow_ups(opportunity_id, meeting_note_id, suggestion_key);
