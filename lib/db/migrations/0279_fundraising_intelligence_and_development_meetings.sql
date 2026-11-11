ALTER TABLE meeting_notes ADD COLUMN IF NOT EXISTS development_week date;
CREATE UNIQUE INDEX IF NOT EXISTS meeting_notes_development_week_uq
  ON meeting_notes (development_week) WHERE development_week IS NOT NULL;
ALTER TABLE meeting_notes DROP CONSTRAINT IF EXISTS meeting_notes_link_or_event;
ALTER TABLE meeting_notes ADD CONSTRAINT meeting_notes_link_or_event CHECK (
  cardinality(person_ids) + cardinality(organization_ids) + cardinality(household_ids) > 0
  OR calendar_event_id IS NOT NULL OR development_week IS NOT NULL
  OR num_nonnulls(person_id, organization_id, household_id) > 0
);

CREATE TABLE IF NOT EXISTS development_agenda (
  id text PRIMARY KEY,
  meeting_id text NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  position integer NOT NULL,
  title text NOT NULL,
  notes text NOT NULL DEFAULT '',
  decision text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','discussing','done','deferred')),
  revision integer NOT NULL DEFAULT 0,
  organization_id text REFERENCES organizations(id) ON DELETE SET NULL,
  person_id text REFERENCES people(id) ON DELETE SET NULL,
  household_id text REFERENCES households(id) ON DELETE SET NULL,
  finding_kind text,
  finding_id text,
  carried_from_id text REFERENCES development_agenda(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS development_agenda_tasks (
  agenda_item_id text NOT NULL REFERENCES development_agenda(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (agenda_item_id, request_id)
);

CREATE TABLE IF NOT EXISTS funder_scan_state (
  organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  last_attempt_at timestamptz,
  requested_at timestamptz,
  last_checked_at timestamptz,
  status text NOT NULL CHECK (status IN ('pending','updates','no_updates','failed','partial')),
  finding_count integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS funder_findings (
  media_mention_id text PRIMARY KEY REFERENCES media_mentions(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  grant_lead_id text REFERENCES grant_leads(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('funding_opportunity','strategy_priorities','leadership_staff','general_news')),
  summary text,
  deadline date,
  official_source boolean NOT NULL DEFAULT false,
  discovered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fundraising_finding_reviews (
  kind text NOT NULL CHECK (kind IN ('media','grant_lead')),
  finding_id text NOT NULL,
  review text NOT NULL CHECK (review IN ('useful','dismissed')),
  reviewed_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (kind, finding_id)
);

CREATE INDEX IF NOT EXISTS development_agenda_meeting_idx ON development_agenda (meeting_id, position);
CREATE INDEX IF NOT EXISTS development_agenda_organization_idx ON development_agenda (organization_id, meeting_id);
CREATE UNIQUE INDEX IF NOT EXISTS development_agenda_finding_uq
  ON development_agenda (meeting_id, finding_kind, finding_id) WHERE finding_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS funder_findings_discovered_at_idx ON funder_findings (discovered_at);
CREATE INDEX IF NOT EXISTS funder_findings_grant_lead_idx ON funder_findings (grant_lead_id);
