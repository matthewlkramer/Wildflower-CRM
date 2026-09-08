-- Flodesk workbook evidence + direct calendar-event pointer for meeting notes.
-- Idempotent: safe to run more than once in dev and production.

CREATE TABLE IF NOT EXISTS newsletter_contacts (
  normalized_email text PRIMARY KEY,
  email text NOT NULL,
  first_name text,
  last_name text,
  email_id text REFERENCES emails(id) ON DELETE SET NULL,
  source_current_subscriber boolean NOT NULL DEFAULT false,
  source_unsubscribed boolean NOT NULL DEFAULT false,
  source_bounced boolean NOT NULL DEFAULT false,
  unsubscribe_evidence text[],
  bounce_evidence text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS newsletter_contacts_email_id_idx
  ON newsletter_contacts(email_id);

CREATE TABLE IF NOT EXISTS newsletter_campaigns (
  id text PRIMARY KEY,
  subject text NOT NULL,
  sent_at timestamptz NOT NULL,
  sent_time_text text,
  preview_url text,
  open_rate numeric(6,5),
  click_rate numeric(6,5),
  source_sheet text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS newsletter_engagement (
  campaign_id text NOT NULL REFERENCES newsletter_campaigns(id) ON DELETE CASCADE,
  normalized_email text NOT NULL,
  email text NOT NULL,
  email_id text REFERENCES emails(id) ON DELETE SET NULL,
  first_name text,
  last_name text,
  delivered_at timestamptz,
  opened boolean NOT NULL DEFAULT false,
  last_opened_at timestamptz,
  total_opens integer NOT NULL DEFAULT 0,
  clicked boolean NOT NULL DEFAULT false,
  last_clicked_at timestamptz,
  total_clicks integer NOT NULL DEFAULT 0,
  clicked_links text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT newsletter_engagement_pk PRIMARY KEY (campaign_id, normalized_email)
);

CREATE INDEX IF NOT EXISTS newsletter_engagement_email_id_idx
  ON newsletter_engagement(email_id);
CREATE INDEX IF NOT EXISTS newsletter_engagement_campaign_opened_idx
  ON newsletter_engagement(campaign_id, opened);
CREATE INDEX IF NOT EXISTS newsletter_engagement_campaign_clicked_idx
  ON newsletter_engagement(campaign_id, clicked);

ALTER TABLE meeting_notes
  ADD COLUMN IF NOT EXISTS calendar_event_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'meeting_notes_calendar_event_id_fkey'
  ) THEN
    ALTER TABLE meeting_notes
      ADD CONSTRAINT meeting_notes_calendar_event_id_fkey
      FOREIGN KEY (calendar_event_id) REFERENCES calendar_events(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Link notes previously created from the dashboard calendar action. That flow
-- prefilled the exact event title/start timestamp and used the calendar owner
-- as the note creator. Only one-to-one exact matches are accepted; ambiguous
-- or manually-entered notes remain unlinked for human review.
WITH exact_candidates AS (
  SELECT
    mn.id AS meeting_note_id,
    ce.id AS calendar_event_id,
    count(*) OVER (PARTITION BY mn.id) AS note_candidate_count,
    count(*) OVER (PARTITION BY ce.id) AS event_candidate_count
  FROM meeting_notes mn
  JOIN calendar_events ce
    ON ce.calendar_user_id = mn.creator_user_id
   AND ce.start_at = mn.meeting_date
   AND lower(trim(coalesce(ce.summary, ''))) = lower(trim(coalesce(mn.title, '')))
   AND (
     coalesce(mn.person_id = ANY(ce.matched_person_ids), false)
     OR coalesce(mn.organization_id = ANY(ce.matched_organization_ids), false)
     OR coalesce(mn.household_id = ANY(ce.matched_household_ids), false)
   )
  WHERE mn.calendar_event_id IS NULL
), safe_candidates AS (
  SELECT meeting_note_id, calendar_event_id
  FROM exact_candidates
  WHERE note_candidate_count = 1 AND event_candidate_count = 1
)
UPDATE meeting_notes mn
SET calendar_event_id = safe.calendar_event_id,
    updated_at = now()
FROM safe_candidates safe
WHERE mn.id = safe.meeting_note_id
  AND mn.calendar_event_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS meeting_notes_calendar_event_id_uq
  ON meeting_notes(calendar_event_id)
  WHERE calendar_event_id IS NOT NULL;

-- Free-form CRM notes may optionally point to a synced meeting. Unlike
-- meeting_notes, multiple free-form notes may document the same meeting.
ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS calendar_event_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notes_calendar_event_id_fkey'
  ) THEN
    ALTER TABLE notes
      ADD CONSTRAINT notes_calendar_event_id_fkey
      FOREIGN KEY (calendar_event_id) REFERENCES calendar_events(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS notes_calendar_event_id_idx
  ON notes(calendar_event_id);
