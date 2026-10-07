-- Expand meeting notes from one primary contact to multiple explicit CRM links.
-- Rerunnable. Apply before publishing code that reads person_ids/organization_ids/
-- household_ids, then rerun after publishing to catch old-code writes in the gap.
ALTER TABLE meeting_notes
  ADD COLUMN IF NOT EXISTS person_ids text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS organization_ids text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS household_ids text[] NOT NULL DEFAULT '{}'::text[];

UPDATE meeting_notes
SET person_ids = CASE
      WHEN person_id IS NOT NULL AND NOT (person_id = ANY(person_ids))
        THEN array_append(person_ids, person_id)
      ELSE person_ids END,
    organization_ids = CASE
      WHEN organization_id IS NOT NULL AND NOT (organization_id = ANY(organization_ids))
        THEN array_append(organization_ids, organization_id)
      ELSE organization_ids END,
    household_ids = CASE
      WHEN household_id IS NOT NULL AND NOT (household_id = ANY(household_ids))
        THEN array_append(household_ids, household_id)
      ELSE household_ids END
WHERE (person_id IS NOT NULL AND NOT (person_id = ANY(person_ids)))
   OR (organization_id IS NOT NULL AND NOT (organization_id = ANY(organization_ids)))
   OR (household_id IS NOT NULL AND NOT (household_id = ANY(household_ids)));

ALTER TABLE meeting_notes DROP CONSTRAINT IF EXISTS meeting_notes_contact_xor;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'meeting_notes'::regclass
      AND conname = 'meeting_notes_link_or_event'
  ) THEN
    ALTER TABLE meeting_notes
      ADD CONSTRAINT meeting_notes_link_or_event CHECK (
        cardinality(person_ids) + cardinality(organization_ids) + cardinality(household_ids) > 0
        OR calendar_event_id IS NOT NULL
        -- Transitional allowance for old-app writes between this migration
        -- and Publish. New API writes only array links. Rerun this migration
        -- after Publish to move any gap writes into the arrays.
        OR num_nonnulls(person_id, organization_id, household_id) > 0
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS meeting_notes_person_ids_gin_idx
  ON meeting_notes USING gin (person_ids);
CREATE INDEX IF NOT EXISTS meeting_notes_organization_ids_gin_idx
  ON meeting_notes USING gin (organization_ids);
CREATE INDEX IF NOT EXISTS meeting_notes_household_ids_gin_idx
  ON meeting_notes USING gin (household_ids);
