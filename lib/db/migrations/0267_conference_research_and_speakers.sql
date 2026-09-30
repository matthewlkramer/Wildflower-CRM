-- 0267: Expand conference date provenance, durable research runs, and speaker review.
-- Additive and idempotent. Existing dates, attendance, and legacy research requests are preserved.

ALTER TABLE conference_events
  ADD COLUMN IF NOT EXISTS date_source_url text,
  ADD COLUMN IF NOT EXISTS date_evidence text,
  ADD COLUMN IF NOT EXISTS date_confidence text,
  ADD COLUMN IF NOT EXISTS date_researched_at timestamptz,
  ADD COLUMN IF NOT EXISTS date_reviewed_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS date_reviewed_at timestamptz;

ALTER TABLE conference_attendance
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'Attendee';

ALTER TABLE conference_attendance
  DROP CONSTRAINT IF EXISTS conference_attendance_source_type_ck;
ALTER TABLE conference_attendance
  ADD CONSTRAINT conference_attendance_source_type_ck
  CHECK (source_type IN ('uploaded_list', 'conference_website', 'wildflower_email', 'manual', 'agenda_speaker'));

ALTER TABLE conference_research_requests
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'agenda_speakers',
  ADD COLUMN IF NOT EXISTS window_key text,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS error text,
  ADD COLUMN IF NOT EXISTS sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS proposed_start_date date,
  ADD COLUMN IF NOT EXISTS proposed_end_date date,
  ADD COLUMN IF NOT EXISTS proposed_date_confidence text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'conference_research_requests_kind_ck'
      AND conrelid = 'conference_research_requests'::regclass
  ) THEN
    ALTER TABLE conference_research_requests
      ADD CONSTRAINT conference_research_requests_kind_ck
      CHECK (kind IN ('dates', 'agenda_speakers'));
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'conference_research_requests_attempts_ck'
      AND conrelid = 'conference_research_requests'::regclass
  ) THEN
    ALTER TABLE conference_research_requests
      ADD CONSTRAINT conference_research_requests_attempts_ck CHECK (attempts >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS conference_research_requests_status_next_attempt_idx
  ON conference_research_requests(status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS conference_research_requests_event_kind_window_uq
  ON conference_research_requests(conference_event_id, kind, window_key);

CREATE TABLE IF NOT EXISTS conference_speaker_proposals (
  id text PRIMARY KEY,
  conference_event_id text NOT NULL REFERENCES conference_events(id) ON DELETE CASCADE,
  conference_research_request_id text REFERENCES conference_research_requests(id) ON DELETE SET NULL,
  speaker_fingerprint text NOT NULL,
  name text NOT NULL,
  title text,
  organization_name text,
  bio text,
  profile_url text,
  source_url text,
  session_evidence text,
  confidence text NOT NULL,
  candidate_person_ids text[] NOT NULL DEFAULT '{}'::text[],
  matched_person_id text REFERENCES people(id) ON DELETE SET NULL,
  matched_organization_id text REFERENCES organizations(id) ON DELETE SET NULL,
  added_person_id text REFERENCES people(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  reviewed_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conference_speaker_proposals_status_ck
    CHECK (status IN ('pending', 'added', 'ignored')),
  CONSTRAINT conference_speaker_proposals_confidence_ck
    CHECK (confidence IN ('high', 'medium', 'low'))
);

CREATE UNIQUE INDEX IF NOT EXISTS conference_speaker_proposals_event_fingerprint_uq
  ON conference_speaker_proposals(conference_event_id, speaker_fingerprint);
CREATE INDEX IF NOT EXISTS conference_speaker_proposals_event_status_idx
  ON conference_speaker_proposals(conference_event_id, status);
CREATE INDEX IF NOT EXISTS conference_speaker_proposals_run_idx
  ON conference_speaker_proposals(conference_research_request_id);