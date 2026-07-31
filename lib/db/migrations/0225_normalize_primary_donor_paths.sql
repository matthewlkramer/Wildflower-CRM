BEGIN;

-- Primary donor paths apply consistently to gifts, opportunities, and pledges.
--
-- This migration does four things:
--   1. Applies preferred donor routing to every newly inserted opportunity/pledge,
--      matching the existing gift insert behavior.
--   2. Records the approved canonical pathways for the Peretsman/Scully and
--      Avi/Sandra Nash clusters.
--   3. Normalizes every historical gift and opportunity/pledge in those clusters
--      to the approved canonical donor, including archived records.
--   4. Audits every CRM donor change while preserving amounts, dates, allocation
--      rows, intermediaries, opportunity links, payment applications, source
--      links, QuickBooks evidence, Stripe evidence, and Donorbox evidence.

CREATE OR REPLACE FUNCTION apply_preferred_donor_to_new_opportunity()
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

  NEW.organization_id := CASE WHEN current_kind = 'organization' THEN current_id ELSE NULL END;
  NEW.individual_giver_person_id := CASE WHEN current_kind = 'individual' THEN current_id ELSE NULL END;
  NEW.household_id := CASE WHEN current_kind = 'household' THEN current_id ELSE NULL END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS opportunities_apply_preferred_donor_trg
  ON opportunities_and_pledges;
CREATE TRIGGER opportunities_apply_preferred_donor_trg
BEFORE INSERT ON opportunities_and_pledges
FOR EACH ROW
EXECUTE FUNCTION apply_preferred_donor_to_new_opportunity();

-- Keep each individual on the authoritative primary household path.
UPDATE people
SET primary_household_id = 'recIJTPGCH2DtgplA', updated_at = now()
WHERE id IN ('recEo8nqWp6DxB5tU', 'recwTfTiygjGC8lyw')
  AND primary_household_id IS DISTINCT FROM 'recIJTPGCH2DtgplA';

UPDATE people
SET primary_household_id = 'rec673AHumJJiIPSy', updated_at = now()
WHERE id IN ('recjOa1ezzMRJmfP7', 'rechFxTLLlbH9c3m6')
  AND primary_household_id IS DISTINCT FROM 'rec673AHumJJiIPSy';

-- Nancy previously pointed directly to the fund. Remove that one-hop override
-- so both Nancy and Bob follow the same explicit path:
-- individual -> primary household -> Scully Peretsman Fund.
DELETE FROM donor_routing_preferences
WHERE source_person_id = 'recEo8nqWp6DxB5tU';

INSERT INTO donor_routing_preferences (
  id,
  source_kind,
  source_household_id,
  mode,
  target_kind,
  target_organization_id,
  created_at,
  updated_at
)
VALUES (
  'drp_peretsman_scully_household_fund',
  'household',
  'recIJTPGCH2DtgplA',
  'target',
  'organization',
  'recEnJihmxpxL6Mes',
  now(),
  now()
)
ON CONFLICT (source_household_id) WHERE source_household_id IS NOT NULL
DO UPDATE SET
  source_kind = 'household',
  mode = 'target',
  target_kind = 'organization',
  target_person_id = NULL,
  target_household_id = NULL,
  target_organization_id = excluded.target_organization_id,
  updated_by_user_id = NULL,
  updated_at = now();

-- Every Avi/Sandra Nash record resolves to the household. The household itself
-- has no explicit preference and therefore remains the endpoint.
INSERT INTO donor_routing_preferences (
  id,
  source_kind,
  source_organization_id,
  mode,
  target_kind,
  target_household_id,
  created_at,
  updated_at
)
VALUES (
  'drp_indira_foundation_nash_household',
  'organization',
  'recR28K8Twq5uV8Q0',
  'target',
  'household',
  'rec673AHumJJiIPSy',
  now(),
  now()
)
ON CONFLICT (source_organization_id) WHERE source_organization_id IS NOT NULL
DO UPDATE SET
  source_kind = 'organization',
  mode = 'target',
  target_kind = 'household',
  target_person_id = NULL,
  target_household_id = excluded.target_household_id,
  target_organization_id = NULL,
  updated_by_user_id = NULL,
  updated_at = now();

CREATE TEMP TABLE donor_cluster_map (
  cluster_name text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_name text NOT NULL,
  target_kind text NOT NULL,
  target_id text NOT NULL,
  target_name text NOT NULL,
  PRIMARY KEY (source_kind, source_id)
) ON COMMIT DROP;

INSERT INTO donor_cluster_map VALUES
  ('Peretsman/Scully', 'individual', 'recEo8nqWp6DxB5tU', 'Nancy Peretsman', 'organization', 'recEnJihmxpxL6Mes', 'Scully Peretsman Fund'),
  ('Peretsman/Scully', 'individual', 'recwTfTiygjGC8lyw', 'Bob Scully', 'organization', 'recEnJihmxpxL6Mes', 'Scully Peretsman Fund'),
  ('Peretsman/Scully', 'household', 'recIJTPGCH2DtgplA', 'Nancy Peretsman and Bob Scully', 'organization', 'recEnJihmxpxL6Mes', 'Scully Peretsman Fund'),
  ('Peretsman/Scully', 'organization', 'recEnJihmxpxL6Mes', 'Scully Peretsman Fund', 'organization', 'recEnJihmxpxL6Mes', 'Scully Peretsman Fund'),
  ('Avi/Sandra Nash', 'individual', 'recjOa1ezzMRJmfP7', 'Avi Nash', 'household', 'rec673AHumJJiIPSy', 'Avi and Sandra Nash'),
  ('Avi/Sandra Nash', 'individual', 'rechFxTLLlbH9c3m6', 'Sandra Nash', 'household', 'rec673AHumJJiIPSy', 'Avi and Sandra Nash'),
  ('Avi/Sandra Nash', 'organization', 'recR28K8Twq5uV8Q0', 'Indira Foundation', 'household', 'rec673AHumJJiIPSy', 'Avi and Sandra Nash'),
  ('Avi/Sandra Nash', 'household', 'rec673AHumJJiIPSy', 'Avi and Sandra Nash', 'household', 'rec673AHumJJiIPSy', 'Avi and Sandra Nash');

CREATE TEMP TABLE donor_cluster_gift_changes ON COMMIT DROP AS
SELECT
  g.id,
  g.organization_id,
  g.individual_giver_person_id,
  g.household_id,
  g.payment_intermediary_id,
  g.opportunity_id,
  m.cluster_name,
  m.source_kind,
  m.source_id,
  m.source_name,
  m.target_kind,
  m.target_id,
  m.target_name
FROM gifts_and_payments g
JOIN donor_cluster_map m ON
  (m.source_kind = 'organization' AND g.organization_id = m.source_id)
  OR (m.source_kind = 'individual' AND g.individual_giver_person_id = m.source_id)
  OR (m.source_kind = 'household' AND g.household_id = m.source_id)
WHERE (m.source_kind, m.source_id) IS DISTINCT FROM (m.target_kind, m.target_id);

INSERT INTO audit_log (
  id,
  actor_user_id,
  action,
  entity_type,
  entity_id,
  summary,
  changes,
  metadata,
  created_at
)
SELECT
  'audit_donor_cluster_0225_gift_' || id,
  NULL,
  'update',
  'gift',
  id,
  'Normalized historical gift to the primary donor path',
  jsonb_build_array(
    jsonb_build_object(
      'field', 'organizationId',
      'from', organization_id,
      'to', CASE WHEN target_kind = 'organization' THEN target_id ELSE NULL END
    ),
    jsonb_build_object(
      'field', 'individualGiverPersonId',
      'from', individual_giver_person_id,
      'to', CASE WHEN target_kind = 'individual' THEN target_id ELSE NULL END
    ),
    jsonb_build_object(
      'field', 'householdId',
      'from', household_id,
      'to', CASE WHEN target_kind = 'household' THEN target_id ELSE NULL END
    )
  ),
  jsonb_build_object(
    'source', 'normalize_primary_donor_paths_0225',
    'cluster', cluster_name,
    'fromDonor', jsonb_build_object('kind', source_kind, 'id', source_id, 'name', source_name),
    'toDonor', jsonb_build_object('kind', target_kind, 'id', target_id, 'name', target_name),
    'accountingEvidenceChanged', false,
    'amountChanged', false,
    'dateChanged', false,
    'allocationsChanged', false,
    'paymentIntermediaryIdPreserved', payment_intermediary_id,
    'opportunityIdPreserved', opportunity_id
  ),
  now()
FROM donor_cluster_gift_changes
ON CONFLICT (id) DO NOTHING;

UPDATE gifts_and_payments g
SET
  organization_id = CASE WHEN c.target_kind = 'organization' THEN c.target_id ELSE NULL END,
  individual_giver_person_id = CASE WHEN c.target_kind = 'individual' THEN c.target_id ELSE NULL END,
  household_id = CASE WHEN c.target_kind = 'household' THEN c.target_id ELSE NULL END,
  updated_at = now()
FROM donor_cluster_gift_changes c
WHERE g.id = c.id;

CREATE TEMP TABLE donor_cluster_opportunity_changes ON COMMIT DROP AS
SELECT
  o.id,
  o.organization_id,
  o.individual_giver_person_id,
  o.household_id,
  o.pledge_committed_at,
  o.status,
  m.cluster_name,
  m.source_kind,
  m.source_id,
  m.source_name,
  m.target_kind,
  m.target_id,
  m.target_name
FROM opportunities_and_pledges o
JOIN donor_cluster_map m ON
  (m.source_kind = 'organization' AND o.organization_id = m.source_id)
  OR (m.source_kind = 'individual' AND o.individual_giver_person_id = m.source_id)
  OR (m.source_kind = 'household' AND o.household_id = m.source_id)
WHERE (m.source_kind, m.source_id) IS DISTINCT FROM (m.target_kind, m.target_id);

INSERT INTO audit_log (
  id,
  actor_user_id,
  action,
  entity_type,
  entity_id,
  summary,
  changes,
  metadata,
  created_at
)
SELECT
  'audit_donor_cluster_0225_opp_' || id,
  NULL,
  'update',
  'opportunity',
  id,
  CASE
    WHEN pledge_committed_at IS NOT NULL THEN 'Normalized historical pledge to the primary donor path'
    ELSE 'Normalized historical opportunity to the primary donor path'
  END,
  jsonb_build_array(
    jsonb_build_object(
      'field', 'organizationId',
      'from', organization_id,
      'to', CASE WHEN target_kind = 'organization' THEN target_id ELSE NULL END
    ),
    jsonb_build_object(
      'field', 'individualGiverPersonId',
      'from', individual_giver_person_id,
      'to', CASE WHEN target_kind = 'individual' THEN target_id ELSE NULL END
    ),
    jsonb_build_object(
      'field', 'householdId',
      'from', household_id,
      'to', CASE WHEN target_kind = 'household' THEN target_id ELSE NULL END
    )
  ),
  jsonb_build_object(
    'source', 'normalize_primary_donor_paths_0225',
    'cluster', cluster_name,
    'recordLifecycle', CASE WHEN pledge_committed_at IS NOT NULL THEN 'pledge' ELSE 'opportunity' END,
    'statusPreserved', status,
    'fromDonor', jsonb_build_object('kind', source_kind, 'id', source_id, 'name', source_name),
    'toDonor', jsonb_build_object('kind', target_kind, 'id', target_id, 'name', target_name),
    'amountsChanged', false,
    'allocationsChanged', false,
    'conditionsChanged', false,
    'scheduleChanged', false,
    'linkedGiftsChanged', false
  ),
  now()
FROM donor_cluster_opportunity_changes
ON CONFLICT (id) DO NOTHING;

UPDATE opportunities_and_pledges o
SET
  organization_id = CASE WHEN c.target_kind = 'organization' THEN c.target_id ELSE NULL END,
  individual_giver_person_id = CASE WHEN c.target_kind = 'individual' THEN c.target_id ELSE NULL END,
  household_id = CASE WHEN c.target_kind = 'household' THEN c.target_id ELSE NULL END,
  updated_at = now()
FROM donor_cluster_opportunity_changes c
WHERE o.id = c.id;

-- Any phase-3 gift-donor proposals for these records are now satisfied or stale.
UPDATE cleanup_queue cq
SET
  status = 'resolved',
  note = cq.note || E'\nResolved by migration 0225: the record was normalized to its approved primary donor path.',
  resolved_at = COALESCE(cq.resolved_at, now()),
  updated_at = now()
WHERE cq.status = 'open'
  AND cq.target_type = 'gift'
  AND cq.proposal_kind = 'gift_donor'
  AND EXISTS (
    SELECT 1
    FROM donor_cluster_gift_changes c
    WHERE c.id = cq.target_id
  );

INSERT INTO audit_log (
  id,
  actor_user_id,
  action,
  entity_type,
  entity_id,
  summary,
  metadata,
  created_at
)
VALUES
  (
    'audit_donor_route_0225_peretsman_household',
    NULL,
    'update',
    'household',
    'recIJTPGCH2DtgplA',
    'Set primary donor path to Scully Peretsman Fund',
    jsonb_build_object(
      'source', 'normalize_primary_donor_paths_0225',
      'route', jsonb_build_array(
        jsonb_build_object('kind', 'household', 'id', 'recIJTPGCH2DtgplA', 'name', 'Nancy Peretsman and Bob Scully'),
        jsonb_build_object('kind', 'organization', 'id', 'recEnJihmxpxL6Mes', 'name', 'Scully Peretsman Fund')
      )
    ),
    now()
  ),
  (
    'audit_donor_route_0225_indira_household',
    NULL,
    'update',
    'organization',
    'recR28K8Twq5uV8Q0',
    'Set primary donor path to Avi and Sandra Nash household',
    jsonb_build_object(
      'source', 'normalize_primary_donor_paths_0225',
      'route', jsonb_build_array(
        jsonb_build_object('kind', 'organization', 'id', 'recR28K8Twq5uV8Q0', 'name', 'Indira Foundation'),
        jsonb_build_object('kind', 'household', 'id', 'rec673AHumJJiIPSy', 'name', 'Avi and Sandra Nash')
      )
    ),
    now()
  )
ON CONFLICT (id) DO NOTHING;

COMMIT;
