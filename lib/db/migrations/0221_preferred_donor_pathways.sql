
-- Preferred donor pathways and one current household authority.
-- Additive and non-destructive: legacy household role rows remain in place.

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS primary_household_id text
  REFERENCES households(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS people_primary_household_id_idx
  ON people(primary_household_id);

ALTER TABLE donor_payment_intermediaries
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS dpi_default_org_uq
  ON donor_payment_intermediaries(organization_id)
  WHERE organization_id IS NOT NULL AND is_default = true;
CREATE UNIQUE INDEX IF NOT EXISTS dpi_default_person_uq
  ON donor_payment_intermediaries(individual_giver_person_id)
  WHERE individual_giver_person_id IS NOT NULL AND is_default = true;
CREATE UNIQUE INDEX IF NOT EXISTS dpi_default_household_uq
  ON donor_payment_intermediaries(household_id)
  WHERE household_id IS NOT NULL AND is_default = true;

CREATE TABLE IF NOT EXISTS donor_routing_preferences (
  id text PRIMARY KEY,
  source_kind text NOT NULL,
  source_person_id text REFERENCES people(id) ON DELETE CASCADE,
  source_household_id text REFERENCES households(id) ON DELETE CASCADE,
  source_organization_id text REFERENCES organizations(id) ON DELETE CASCADE,
  mode text NOT NULL,
  target_kind text,
  target_person_id text REFERENCES people(id) ON DELETE RESTRICT,
  target_household_id text REFERENCES households(id) ON DELETE RESTRICT,
  target_organization_id text REFERENCES organizations(id) ON DELETE RESTRICT,
  updated_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT donor_routing_source_shape_ck CHECK (
    num_nonnulls(source_person_id, source_household_id, source_organization_id) = 1
    AND (
      (source_kind = 'individual' AND source_person_id IS NOT NULL)
      OR (source_kind = 'household' AND source_household_id IS NOT NULL)
      OR (source_kind = 'organization' AND source_organization_id IS NOT NULL)
    )
  ),
  CONSTRAINT donor_routing_target_shape_ck CHECK (
    (
      mode = 'ask'
      AND target_kind IS NULL
      AND num_nonnulls(target_person_id, target_household_id, target_organization_id) = 0
    ) OR (
      mode = 'target'
      AND target_kind IS NOT NULL
      AND num_nonnulls(target_person_id, target_household_id, target_organization_id) = 1
      AND (
        (target_kind = 'individual' AND target_person_id IS NOT NULL)
        OR (target_kind = 'household' AND target_household_id IS NOT NULL)
        OR (target_kind = 'organization' AND target_organization_id IS NOT NULL)
      )
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS donor_routing_source_person_uq
  ON donor_routing_preferences(source_person_id)
  WHERE source_person_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS donor_routing_source_household_uq
  ON donor_routing_preferences(source_household_id)
  WHERE source_household_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS donor_routing_source_org_uq
  ON donor_routing_preferences(source_organization_id)
  WHERE source_organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS donor_routing_target_person_idx
  ON donor_routing_preferences(target_person_id);
CREATE INDEX IF NOT EXISTS donor_routing_target_household_idx
  ON donor_routing_preferences(target_household_id);
CREATE INDEX IF NOT EXISTS donor_routing_target_org_idx
  ON donor_routing_preferences(target_organization_id);

-- Backfill only unambiguous household relationships. If a person has several
-- distinct current households, leave the new authority blank for human review.
WITH current_households AS (
  SELECT
    person_id,
    array_agg(DISTINCT household_id) FILTER (WHERE household_id IS NOT NULL) AS household_ids
  FROM people_entity_roles
  WHERE entity_type = 'household' AND current = 'current'
  GROUP BY person_id
), unambiguous AS (
  SELECT person_id, household_ids[1] AS household_id
  FROM current_households
  WHERE cardinality(household_ids) = 1
)
UPDATE people p
SET primary_household_id = u.household_id,
    updated_at = now()
FROM unambiguous u
WHERE p.id = u.person_id
  AND p.primary_household_id IS NULL;
