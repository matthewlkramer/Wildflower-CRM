-- Donor/payment-intermediary cleanup.
--
-- Makes relationship removal reversible, removes unusable defaults, and
-- centralizes the source-first default resolution used by both the API and
-- the new-gift trigger.

ALTER TABLE donor_payment_intermediaries
  ADD COLUMN IF NOT EXISTS archived_at timestamp;

-- Data repair: an archived payment intermediary cannot remain a donor's
-- preferred intermediary. Relationship rows are retained for history.
UPDATE donor_payment_intermediaries dpi
SET is_default = false,
    updated_at = now()
FROM payment_intermediaries pi
WHERE pi.id = dpi.payment_intermediary_id
  AND pi.archived_at IS NOT NULL
  AND dpi.is_default = true;

UPDATE donor_payment_intermediaries
SET is_default = false,
    updated_at = now()
WHERE archived_at IS NOT NULL
  AND is_default = true;

ALTER TABLE donor_payment_intermediaries
  DROP CONSTRAINT IF EXISTS dpi_default_active_ck;
ALTER TABLE donor_payment_intermediaries
  ADD CONSTRAINT dpi_default_active_ck
  CHECK (NOT is_default OR archived_at IS NULL);

DROP INDEX IF EXISTS dpi_default_org_uq;
DROP INDEX IF EXISTS dpi_default_person_uq;
DROP INDEX IF EXISTS dpi_default_household_uq;

CREATE UNIQUE INDEX dpi_default_org_uq
  ON donor_payment_intermediaries (organization_id)
  WHERE organization_id IS NOT NULL
    AND is_default = true
    AND archived_at IS NULL;
CREATE UNIQUE INDEX dpi_default_person_uq
  ON donor_payment_intermediaries (individual_giver_person_id)
  WHERE individual_giver_person_id IS NOT NULL
    AND is_default = true
    AND archived_at IS NULL;
CREATE UNIQUE INDEX dpi_default_household_uq
  ON donor_payment_intermediaries (household_id)
  WHERE household_id IS NOT NULL
    AND is_default = true
    AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS donor_payment_intermediaries_archived_at_idx
  ON donor_payment_intermediaries (archived_at);

CREATE OR REPLACE FUNCTION resolve_default_payment_intermediary(
  source_kind text,
  source_id text,
  resolved_kind text,
  resolved_id text
)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  intermediary_id text;
BEGIN
  -- A default explicitly chosen on the record the user selected wins. This
  -- lets a person route the donor of record to a household or organization
  -- without losing that person's own DAF preference.
  SELECT dpi.payment_intermediary_id
  INTO intermediary_id
  FROM donor_payment_intermediaries dpi
  JOIN payment_intermediaries pi ON pi.id = dpi.payment_intermediary_id
  WHERE dpi.is_default = true
    AND dpi.archived_at IS NULL
    AND pi.archived_at IS NULL
    AND (
      (source_kind = 'organization' AND dpi.organization_id = source_id)
      OR (source_kind = 'individual' AND dpi.individual_giver_person_id = source_id)
      OR (source_kind = 'household' AND dpi.household_id = source_id)
    )
  ORDER BY dpi.updated_at DESC, dpi.id
  LIMIT 1;

  IF intermediary_id IS NOT NULL THEN
    RETURN intermediary_id;
  END IF;

  IF resolved_kind IS NULL OR resolved_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT dpi.payment_intermediary_id
  INTO intermediary_id
  FROM donor_payment_intermediaries dpi
  JOIN payment_intermediaries pi ON pi.id = dpi.payment_intermediary_id
  WHERE dpi.is_default = true
    AND dpi.archived_at IS NULL
    AND pi.archived_at IS NULL
    AND (
      (resolved_kind = 'organization' AND dpi.organization_id = resolved_id)
      OR (resolved_kind = 'individual' AND dpi.individual_giver_person_id = resolved_id)
      OR (resolved_kind = 'household' AND dpi.household_id = resolved_id)
    )
  ORDER BY dpi.updated_at DESC, dpi.id
  LIMIT 1;

  RETURN intermediary_id;
END;
$$;

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

  IF NEW.payment_intermediary_id IS NULL THEN
    NEW.payment_intermediary_id := resolve_default_payment_intermediary(
      source_kind,
      source_id,
      current_kind,
      current_id
    );
  END IF;

  NEW.organization_id := CASE WHEN current_kind = 'organization' THEN current_id ELSE NULL END;
  NEW.individual_giver_person_id := CASE WHEN current_kind = 'individual' THEN current_id ELSE NULL END;
  NEW.household_id := CASE WHEN current_kind = 'household' THEN current_id ELSE NULL END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gifts_apply_preferred_donor_trg ON gifts_and_payments;
CREATE TRIGGER gifts_apply_preferred_donor_trg
BEFORE INSERT ON gifts_and_payments
FOR EACH ROW
EXECUTE FUNCTION apply_preferred_donor_to_new_gift();

CREATE OR REPLACE FUNCTION clear_defaults_for_archived_payment_intermediary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    UPDATE donor_payment_intermediaries
    SET is_default = false,
        updated_at = now()
    WHERE payment_intermediary_id = NEW.id
      AND is_default = true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_intermediary_clear_defaults_trg
  ON payment_intermediaries;
CREATE TRIGGER payment_intermediary_clear_defaults_trg
AFTER UPDATE OF archived_at ON payment_intermediaries
FOR EACH ROW
EXECUTE FUNCTION clear_defaults_for_archived_payment_intermediary();
