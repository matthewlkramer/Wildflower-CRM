-- Donor attribution phase 2.
-- No preference row = automatic default. Explicit self is stored.
ALTER TABLE donor_routing_preferences
  DROP CONSTRAINT IF EXISTS donor_routing_target_shape_ck;

ALTER TABLE donor_routing_preferences
  ADD CONSTRAINT donor_routing_target_shape_ck CHECK (
    (
      mode IN ('self', 'ask')
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
  );

CREATE OR REPLACE FUNCTION apply_preferred_donor_to_new_gift()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_kind text;
  source_id text;
  current_kind text;
  current_id text;
  pref_mode text;
  next_kind text;
  next_id text;
  primary_household text;
  default_intermediary text;
  visited text[] := ARRAY[]::text[];
  route_key text;
  depth integer := 0;
BEGIN
  IF num_nonnulls(
    NEW.organization_id,
    NEW.individual_giver_person_id,
    NEW.household_id
  ) <> 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS NOT NULL THEN
    source_kind := 'organization';
    source_id := NEW.organization_id;
  ELSIF NEW.individual_giver_person_id IS NOT NULL THEN
    source_kind := 'individual';
    source_id := NEW.individual_giver_person_id;
  ELSE
    source_kind := 'household';
    source_id := NEW.household_id;
  END IF;

  current_kind := source_kind;
  current_id := source_id;

  LOOP
    depth := depth + 1;
    IF depth > 12 THEN
      RAISE EXCEPTION 'donor_routing_too_deep';
    END IF;

    route_key := current_kind || ':' || current_id;
    IF route_key = ANY(visited) THEN
      RAISE EXCEPTION 'donor_routing_cycle';
    END IF;
    visited := array_append(visited, route_key);

    SELECT
      mode,
      target_kind,
      CASE
        WHEN target_kind = 'individual' THEN target_person_id
        WHEN target_kind = 'household' THEN target_household_id
        WHEN target_kind = 'organization' THEN target_organization_id
      END
    INTO pref_mode, next_kind, next_id
    FROM donor_routing_preferences
    WHERE
      (current_kind = 'individual' AND source_person_id = current_id)
      OR (current_kind = 'household' AND source_household_id = current_id)
      OR (current_kind = 'organization' AND source_organization_id = current_id)
    LIMIT 1;

    IF NOT FOUND THEN
      IF current_kind = 'individual' THEN
        SELECT primary_household_id
        INTO primary_household
        FROM people
        WHERE id = current_id;

        IF primary_household IS NOT NULL THEN
          current_kind := 'household';
          current_id := primary_household;
          CONTINUE;
        END IF;
      END IF;
      EXIT;
    END IF;

    IF pref_mode = 'self' THEN
      EXIT;
    ELSIF pref_mode = 'ask' THEN
      RAISE EXCEPTION 'donor_routing_decision_required';
    ELSIF pref_mode = 'target' AND next_kind IS NOT NULL AND next_id IS NOT NULL THEN
      current_kind := next_kind;
      current_id := next_id;
    ELSE
      RAISE EXCEPTION 'donor_routing_invalid_preference';
    END IF;
  END LOOP;

  NEW.organization_id := CASE WHEN current_kind = 'organization' THEN current_id ELSE NULL END;
  NEW.individual_giver_person_id := CASE WHEN current_kind = 'individual' THEN current_id ELSE NULL END;
  NEW.household_id := CASE WHEN current_kind = 'household' THEN current_id ELSE NULL END;

  IF NEW.payment_intermediary_id IS NULL THEN
    SELECT dpi.payment_intermediary_id
    INTO default_intermediary
    FROM donor_payment_intermediaries dpi
    WHERE dpi.is_default = true
      AND (
        (current_kind = 'organization' AND dpi.organization_id = current_id)
        OR (current_kind = 'individual' AND dpi.individual_giver_person_id = current_id)
        OR (current_kind = 'household' AND dpi.household_id = current_id)
      )
    LIMIT 1;

    IF default_intermediary IS NULL
       AND (current_kind <> source_kind OR current_id <> source_id) THEN
      SELECT dpi.payment_intermediary_id
      INTO default_intermediary
      FROM donor_payment_intermediaries dpi
      WHERE dpi.is_default = true
        AND (
          (source_kind = 'organization' AND dpi.organization_id = source_id)
          OR (source_kind = 'individual' AND dpi.individual_giver_person_id = source_id)
          OR (source_kind = 'household' AND dpi.household_id = source_id)
        )
      LIMIT 1;
    END IF;

    NEW.payment_intermediary_id := default_intermediary;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gifts_apply_preferred_donor_trg ON gifts_and_payments;
CREATE TRIGGER gifts_apply_preferred_donor_trg
BEFORE INSERT ON gifts_and_payments
FOR EACH ROW
EXECUTE FUNCTION apply_preferred_donor_to_new_gift();

-- Approved production seed: Arthur Rock routes to Arthur Rock & Company;
-- Vanguard Charitable is the organization's default intermediary. Only seed
-- when each name resolves unambiguously.
WITH arthur AS (
  SELECT min(id) AS id
  FROM people
  WHERE lower(btrim(coalesce(full_name, concat_ws(' ', first_name, last_name)))) = 'arthur rock'
  HAVING count(*) = 1
), company AS (
  SELECT min(id) AS id
  FROM organizations
  WHERE lower(btrim(name)) = 'arthur rock & company'
  HAVING count(*) = 1
)
INSERT INTO donor_routing_preferences (
  id, source_kind, source_person_id, mode,
  target_kind, target_organization_id, created_at, updated_at
)
SELECT
  'drp_arthur_rock_company',
  'individual',
  arthur.id,
  'target',
  'organization',
  company.id,
  now(),
  now()
FROM arthur, company
ON CONFLICT (source_person_id) WHERE source_person_id IS NOT NULL
DO UPDATE SET
  mode = 'target',
  target_kind = 'organization',
  target_person_id = NULL,
  target_household_id = NULL,
  target_organization_id = excluded.target_organization_id,
  updated_at = now();

WITH company AS (
  SELECT min(id) AS id
  FROM organizations
  WHERE lower(btrim(name)) = 'arthur rock & company'
  HAVING count(*) = 1
)
UPDATE donor_payment_intermediaries dpi
SET is_default = false, updated_at = now()
FROM company
WHERE dpi.organization_id = company.id
  AND dpi.is_default = true;

WITH company AS (
  SELECT min(id) AS id
  FROM organizations
  WHERE lower(btrim(name)) = 'arthur rock & company'
  HAVING count(*) = 1
), vanguard AS (
  SELECT min(id) AS id
  FROM payment_intermediaries
  WHERE lower(btrim(name)) = 'vanguard charitable'
  HAVING count(*) = 1
)
INSERT INTO donor_payment_intermediaries (
  id, organization_id, payment_intermediary_id, is_default, created_at, updated_at
)
SELECT
  'dpi_arthur_rock_company_vanguard',
  company.id,
  vanguard.id,
  true,
  now(),
  now()
FROM company, vanguard
ON CONFLICT (organization_id, payment_intermediary_id)
  WHERE organization_id IS NOT NULL
DO UPDATE SET is_default = true, updated_at = now();
