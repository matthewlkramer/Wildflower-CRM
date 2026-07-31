BEGIN;

-- Donor attribution phase 3.
--
-- 1. Normalize only unambiguous historical individual -> primary-household gifts.
-- 2. Seed reviewable donor/default-intermediary proposals for everything else
--    with a concrete, evidence-backed recommendation.
-- 3. Retire people_entity_roles as a household-membership authority.
--
-- This migration never edits QuickBooks, Stripe, Donorbox, payment_units,
-- payment_applications, source_links, amounts, dates, coding, or intermediaries
-- already stored on gifts.

ALTER TABLE cleanup_queue
  ADD COLUMN IF NOT EXISTS proposal_kind text,
  ADD COLUMN IF NOT EXISTS proposal_confidence text,
  ADD COLUMN IF NOT EXISTS proposed_changes jsonb;

ALTER TABLE cleanup_queue
  DROP CONSTRAINT IF EXISTS cleanup_queue_proposal_kind_ck;
ALTER TABLE cleanup_queue
  ADD CONSTRAINT cleanup_queue_proposal_kind_ck CHECK (
    proposal_kind IS NULL OR proposal_kind IN ('gift_donor', 'default_intermediary')
  );
ALTER TABLE cleanup_queue
  DROP CONSTRAINT IF EXISTS cleanup_queue_proposal_confidence_ck;
ALTER TABLE cleanup_queue
  ADD CONSTRAINT cleanup_queue_proposal_confidence_ck CHECK (
    proposal_confidence IS NULL OR proposal_confidence IN ('high', 'medium', 'low')
  );
CREATE INDEX IF NOT EXISTS cleanup_queue_proposal_status_idx
  ON cleanup_queue(status, proposal_confidence, proposal_kind);

-- Capture any final unambiguous current household rows before retiring them.
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

-- Preserve unresolved ambiguity in the ordinary cleanup queue before deleting
-- the transitional role rows.
WITH current_households AS (
  SELECT
    per.person_id,
    array_agg(DISTINCT per.household_id) FILTER (WHERE per.household_id IS NOT NULL) AS household_ids,
    string_agg(DISTINCT h.name, ', ' ORDER BY h.name) AS household_names
  FROM people_entity_roles per
  LEFT JOIN households h ON h.id = per.household_id
  WHERE per.entity_type = 'household' AND per.current = 'current'
  GROUP BY per.person_id
), ambiguous AS (
  SELECT ch.*, COALESCE(NULLIF(btrim(p.full_name), ''),
    NULLIF(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), p.id) AS person_name
  FROM current_households ch
  JOIN people p ON p.id = ch.person_id
  WHERE cardinality(ch.household_ids) > 1 AND p.primary_household_id IS NULL
)
INSERT INTO cleanup_queue (
  id, target_type, target_id, reason_code, note, status,
  proposal_confidence, flagged_at, created_at, updated_at
)
SELECT
  'cleanup_primary_household_' || person_id,
  'person',
  person_id,
  'primary_household_review',
  'Choose one primary household for ' || person_name || '. Legacy current household rows named: ' || household_names || '.',
  'open',
  'low',
  now(), now(), now()
FROM ambiguous
ON CONFLICT (target_type, target_id, reason_code) DO NOTHING;

-- High-confidence historical normalization: an active gift is still recorded to
-- an individual, that individual has one authoritative primary household, and
-- the individual has no explicit routing override. The current routing rule is
-- therefore unambiguous.
CREATE TEMP TABLE phase3_auto_household_gifts ON COMMIT DROP AS
SELECT
  g.id AS gift_id,
  g.individual_giver_person_id AS person_id,
  p.primary_household_id AS household_id,
  COALESCE(NULLIF(btrim(p.full_name), ''),
    NULLIF(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), p.id) AS person_name,
  h.name AS household_name
FROM gifts_and_payments g
JOIN people p ON p.id = g.individual_giver_person_id
JOIN households h ON h.id = p.primary_household_id
WHERE g.archived_at IS NULL
  AND g.individual_giver_person_id IS NOT NULL
  AND p.primary_household_id IS NOT NULL
  AND h.archived_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM donor_routing_preferences drp
    WHERE drp.source_person_id = p.id
  );

INSERT INTO audit_log (
  id, actor_user_id, action, entity_type, entity_id, summary, changes, metadata, created_at
)
SELECT
  'audit_donor_phase3_' || gift_id,
  NULL,
  'update',
  'gift',
  gift_id,
  'Normalized historical donor to primary household',
  jsonb_build_array(
    jsonb_build_object('field', 'individualGiverPersonId', 'from', person_id, 'to', NULL),
    jsonb_build_object('field', 'householdId', 'from', NULL, 'to', household_id)
  ),
  jsonb_build_object(
    'source', 'donor_attribution_phase_3',
    'confidence', 'high',
    'fromDonor', jsonb_build_object('kind', 'individual', 'id', person_id, 'name', person_name),
    'toDonor', jsonb_build_object('kind', 'household', 'id', household_id, 'name', household_name)
  ),
  now()
FROM phase3_auto_household_gifts
ON CONFLICT (id) DO NOTHING;

INSERT INTO cleanup_queue (
  id, target_type, target_id, reason_code, note, status,
  proposal_kind, proposal_confidence, proposed_changes,
  flagged_at, resolved_at, created_at, updated_at
)
SELECT
  'cleanup_donor_auto_' || gift_id,
  'gift',
  gift_id,
  'donor_attribution_auto_normalized',
  'Automatically changed the historical donor from ' || person_name || ' to ' || household_name ||
    ' because the individual has that primary household and no explicit pathway override. Accounting evidence was unchanged.',
  'resolved',
  'gift_donor',
  'high',
  jsonb_build_object(
    'fromDonor', jsonb_build_object('kind', 'individual', 'id', person_id, 'name', person_name),
    'toDonor', jsonb_build_object('kind', 'household', 'id', household_id, 'name', household_name),
    'rationale', 'Automatic primary-household pathway with no explicit override.'
  ),
  now(), now(), now(), now()
FROM phase3_auto_household_gifts
ON CONFLICT (target_type, target_id, reason_code) DO NOTHING;

UPDATE gifts_and_payments g
SET individual_giver_person_id = NULL,
    household_id = a.household_id,
    organization_id = NULL,
    updated_at = now()
FROM phase3_auto_household_gifts a
WHERE g.id = a.gift_id;

-- Reviewable donor proposals for explicit one-hop target pathways. These are
-- intentionally NOT auto-applied because an explicit pathway may have been
-- configured after the historical gift was made.
WITH candidates AS (
  SELECT
    g.id AS gift_id,
    CASE
      WHEN g.organization_id IS NOT NULL THEN 'organization'
      WHEN g.individual_giver_person_id IS NOT NULL THEN 'individual'
      ELSE 'household'
    END AS from_kind,
    COALESCE(g.organization_id, g.individual_giver_person_id, g.household_id) AS from_id,
    drp.target_kind AS to_kind,
    CASE
      WHEN drp.target_kind = 'organization' THEN drp.target_organization_id
      WHEN drp.target_kind = 'individual' THEN drp.target_person_id
      ELSE drp.target_household_id
    END AS to_id
  FROM gifts_and_payments g
  JOIN donor_routing_preferences drp ON
    (drp.source_kind = 'organization' AND drp.source_organization_id = g.organization_id)
    OR (drp.source_kind = 'individual' AND drp.source_person_id = g.individual_giver_person_id)
    OR (drp.source_kind = 'household' AND drp.source_household_id = g.household_id)
  WHERE g.archived_at IS NULL
    AND drp.mode = 'target'
), named AS (
  SELECT c.*,
    CASE c.from_kind
      WHEN 'organization' THEN (SELECT CASE WHEN anonymous THEN 'Anonymous' ELSE name END FROM organizations WHERE id = c.from_id)
      WHEN 'individual' THEN (SELECT CASE WHEN anonymous THEN 'Anonymous' ELSE COALESCE(NULLIF(btrim(full_name), ''), NULLIF(btrim(concat_ws(' ', first_name, last_name)), ''), id) END FROM people WHERE id = c.from_id)
      ELSE (SELECT name FROM households WHERE id = c.from_id)
    END AS from_name,
    CASE c.to_kind
      WHEN 'organization' THEN (SELECT CASE WHEN anonymous THEN 'Anonymous' ELSE name END FROM organizations WHERE id = c.to_id)
      WHEN 'individual' THEN (SELECT CASE WHEN anonymous THEN 'Anonymous' ELSE COALESCE(NULLIF(btrim(full_name), ''), NULLIF(btrim(concat_ws(' ', first_name, last_name)), ''), id) END FROM people WHERE id = c.to_id)
      ELSE (SELECT name FROM households WHERE id = c.to_id)
    END AS to_name
  FROM candidates c
  WHERE c.to_id IS NOT NULL
    AND (c.from_kind, c.from_id) IS DISTINCT FROM (c.to_kind, c.to_id)
)
INSERT INTO cleanup_queue (
  id, target_type, target_id, reason_code, note, status,
  proposal_kind, proposal_confidence, proposed_changes,
  flagged_at, created_at, updated_at
)
SELECT
  'cleanup_donor_review_' || gift_id,
  'gift',
  gift_id,
  'donor_attribution_review',
  'Review changing the historical donor from ' || COALESCE(from_name, from_kind || ' ' || from_id) ||
    ' to ' || COALESCE(to_name, to_kind || ' ' || to_id) || '. Accounting evidence will remain unchanged.',
  'open',
  'gift_donor',
  'medium',
  jsonb_build_object(
    'fromDonor', jsonb_build_object('kind', from_kind, 'id', from_id, 'name', from_name),
    'toDonor', jsonb_build_object('kind', to_kind, 'id', to_id, 'name', to_name),
    'rationale', 'The gift donor now has an explicit preferred pathway to the proposed donor.'
  ),
  now(), now(), now()
FROM named
ON CONFLICT (target_type, target_id, reason_code) DO NOTHING;

-- A single historical intermediary is useful evidence, but not strong enough to
-- set a default automatically. Seed a review proposal only when the donor has no
-- existing default and exactly one intermediary across active gifts.
WITH donor_history AS (
  SELECT
    CASE
      WHEN organization_id IS NOT NULL THEN 'organization'
      WHEN individual_giver_person_id IS NOT NULL THEN 'individual'
      ELSE 'household'
    END AS donor_kind,
    COALESCE(organization_id, individual_giver_person_id, household_id) AS donor_id,
    min(payment_intermediary_id) AS payment_intermediary_id,
    count(DISTINCT payment_intermediary_id) AS intermediary_count
  FROM gifts_and_payments
  WHERE archived_at IS NULL AND payment_intermediary_id IS NOT NULL
  GROUP BY 1, 2
  HAVING count(DISTINCT payment_intermediary_id) = 1
), candidates AS (
  SELECT dh.*, pi.name AS intermediary_name, pi.type AS intermediary_type,
    CASE dh.donor_kind
      WHEN 'organization' THEN (SELECT CASE WHEN anonymous THEN 'Anonymous' ELSE name END FROM organizations WHERE id = dh.donor_id AND archived_at IS NULL)
      WHEN 'individual' THEN (SELECT CASE WHEN anonymous THEN 'Anonymous' ELSE COALESCE(NULLIF(btrim(full_name), ''), NULLIF(btrim(concat_ws(' ', first_name, last_name)), ''), id) END FROM people WHERE id = dh.donor_id AND archived_at IS NULL)
      ELSE (SELECT name FROM households WHERE id = dh.donor_id AND archived_at IS NULL)
    END AS donor_name
  FROM donor_history dh
  JOIN payment_intermediaries pi ON pi.id = dh.payment_intermediary_id AND pi.archived_at IS NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM donor_payment_intermediaries dpi
    WHERE dpi.is_default = true AND (
      (dh.donor_kind = 'organization' AND dpi.organization_id = dh.donor_id)
      OR (dh.donor_kind = 'individual' AND dpi.individual_giver_person_id = dh.donor_id)
      OR (dh.donor_kind = 'household' AND dpi.household_id = dh.donor_id)
    )
  )
)
INSERT INTO cleanup_queue (
  id, target_type, target_id, reason_code, note, status,
  proposal_kind, proposal_confidence, proposed_changes,
  flagged_at, created_at, updated_at
)
SELECT
  'cleanup_intermediary_' || donor_kind || '_' || donor_id,
  CASE WHEN donor_kind = 'individual' THEN 'person' ELSE donor_kind END,
  donor_id,
  'donor_intermediary_review',
  'Review setting ' || intermediary_name || ' as the default payment intermediary for ' ||
    COALESCE(donor_name, donor_kind || ' ' || donor_id) ||
    '. It is the only intermediary seen on active historical gifts, but the setting requires human confirmation.',
  'open',
  'default_intermediary',
  'medium',
  jsonb_build_object(
    'donor', jsonb_build_object('kind', donor_kind, 'id', donor_id, 'name', donor_name),
    'paymentIntermediary', jsonb_build_object('id', payment_intermediary_id, 'name', intermediary_name, 'type', intermediary_type),
    'rationale', 'Exactly one payment intermediary appears across this donor''s active historical gifts.'
  ),
  now(), now(), now()
FROM candidates
WHERE donor_name IS NOT NULL
ON CONFLICT (target_type, target_id, reason_code) DO NOTHING;

-- people.primary_household_id is now the sole household-membership authority.
DELETE FROM people_entity_roles
WHERE entity_type = 'household' OR household_id IS NOT NULL;

ALTER TABLE people_entity_roles
  DROP CONSTRAINT IF EXISTS per_entity_discriminator;
ALTER TABLE people_entity_roles
  ADD CONSTRAINT per_entity_discriminator CHECK (
    (entity_type = 'organization' AND organization_id IS NOT NULL AND payment_intermediary_id IS NULL AND household_id IS NULL)
    OR (entity_type = 'payment_intermediary' AND payment_intermediary_id IS NOT NULL AND organization_id IS NULL AND household_id IS NULL)
  );
ALTER TABLE people_entity_roles
  DROP CONSTRAINT IF EXISTS per_household_membership_retired;
ALTER TABLE people_entity_roles
  ADD CONSTRAINT per_household_membership_retired CHECK (
    entity_type <> 'household' AND household_id IS NULL
  );

COMMIT;
