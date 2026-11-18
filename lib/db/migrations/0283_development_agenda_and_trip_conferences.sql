ALTER TABLE development_agenda ADD COLUMN IF NOT EXISTS template_key text;
ALTER TABLE development_agenda ADD COLUMN IF NOT EXISTS removed_at timestamptz;
DROP INDEX IF EXISTS development_agenda_finding_uq;
CREATE UNIQUE INDEX development_agenda_finding_uq ON development_agenda (meeting_id, finding_kind, finding_id)
  WHERE finding_id IS NOT NULL AND removed_at IS NULL;
ALTER TABLE trip_plans ADD COLUMN IF NOT EXISTS conference_event_id text
  REFERENCES conference_events(id) ON DELETE SET NULL;
ALTER TABLE trip_plans ADD COLUMN IF NOT EXISTS outreach_organization_id text
  REFERENCES organizations(id) ON DELETE SET NULL;

UPDATE development_agenda
SET template_key = CASE title
  WHEN 'Review open action items' THEN 'open_actions'
  WHEN 'Discuss fundraising updates' THEN 'fundraising_updates'
  WHEN 'Agree on next steps' THEN 'next_steps'
END
WHERE template_key IS NULL
  AND organization_id IS NULL AND person_id IS NULL AND household_id IS NULL
  AND finding_id IS NULL
  AND ((title = 'Review open action items' AND position = 0)
    OR (title = 'Discuss fundraising updates' AND position = 1)
    OR title = 'Agree on next steps');
