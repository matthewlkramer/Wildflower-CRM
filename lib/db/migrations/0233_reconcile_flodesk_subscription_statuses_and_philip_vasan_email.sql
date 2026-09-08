-- 0233: Reconcile imported Flodesk subscription evidence and Philip Vasan's email.
--
-- WHY: The completed Flodesk workbook import deliberately preserved source evidence
-- without changing CRM newsletter fields. The product owner subsequently ratified
-- current Flodesk membership as the operational authority for exact-email person
-- matches, with current-subscriber evidence taking priority over historical
-- unsubscribe evidence. Philip Vasan's BlackRock address was also confirmed as his
-- secondary address.
--
-- SAFE / IDEMPOTENT:
--   * aborts unless the reviewed first-run target counts are exactly 95 subscribed
--     people and 9 unsubscribed people, with no person mapped to both states;
--   * only updates people whose current CRM state differs from the derived target;
--   * inserts deterministic email/audit ids and never duplicates a global email;
--   * accepts only the fully completed post-state on re-run, making re-runs no-ops;
--   * asserts the final subscription, Philip-email, evidence-link, and audit state.
--
-- Production is human-applied from the repository root:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0233_reconcile_flodesk_subscription_statuses_and_philip_vasan_email.sql
--
-- Do not add BEGIN/COMMIT: psql -1 owns the transaction.

DO $$
DECLARE
  v_subscribe_targets integer;
  v_unsubscribe_targets integer;
  v_ambiguous_people integer;
  v_audit_count integer;
  v_primary_count integer;
  v_blackrock_count integer;
  v_blackrock_valid_count integer;
BEGIN
  /*
   * Each imported contact has one normalized address and emails.email has a
   * global lower(email) unique index. A person can still have multiple matched
   * addresses, so fail closed if their contacts resolve to different targets.
   */
  WITH matched AS (
    SELECT
      p.id AS person_id,
      CASE
        WHEN nc.source_current_subscriber THEN 'subscribed'
        WHEN nc.source_unsubscribed THEN 'unsubscribed'
      END AS flodesk_status,
      p.newsletter,
      p.unsubscribed_to_newsletter
    FROM newsletter_contacts nc
    JOIN emails e ON lower(btrim(e.email)) = nc.normalized_email
    JOIN people p ON p.id = e.person_id
    WHERE e.person_id IS NOT NULL
      AND (nc.source_current_subscriber OR nc.source_unsubscribed)
  ),
  per_person AS (
    SELECT
      person_id,
      bool_or(flodesk_status = 'subscribed') AS has_subscribed_status,
      bool_or(flodesk_status = 'unsubscribed') AS has_unsubscribed_status,
      bool_or(
        flodesk_status = 'subscribed'
        AND (NOT newsletter OR unsubscribed_to_newsletter)
      ) AS needs_subscribed_update,
      bool_or(
        flodesk_status = 'unsubscribed'
        AND (newsletter OR NOT unsubscribed_to_newsletter)
      ) AS needs_unsubscribed_update
    FROM matched
    GROUP BY person_id
  )
  SELECT
    count(*) FILTER (
      WHERE needs_subscribed_update AND NOT needs_unsubscribed_update
    )::integer,
    count(*) FILTER (
      WHERE needs_unsubscribed_update AND NOT needs_subscribed_update
    )::integer,
    count(*) FILTER (
      WHERE has_subscribed_status AND has_unsubscribed_status
    )::integer
  INTO v_subscribe_targets, v_unsubscribe_targets, v_ambiguous_people
  FROM per_person;

  SELECT count(*)::integer
    INTO v_audit_count
    FROM audit_log
   WHERE id = 'audit_0233_flodesk_subscription_reconciliation';

  SELECT count(*)::integer
    INTO v_primary_count
    FROM emails
   WHERE lower(email) = lower('philip@vasan.com')
     AND person_id = 'recMWdUfgt0ypOtnw';

  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE id = 'em_0233_philip_vasan_blackrock'
             AND person_id = 'recMWdUfgt0ypOtnw'
         )::integer
    INTO v_blackrock_count, v_blackrock_valid_count
    FROM emails
   WHERE lower(email) = lower('philip.vasan@blackrock.com');

  IF v_ambiguous_people <> 0 THEN
    RAISE EXCEPTION
      '0233 preflight: % person(s) have conflicting exact-email Flodesk subscription states',
      v_ambiguous_people;
  END IF;

  IF v_primary_count <> 1 THEN
    RAISE EXCEPTION
      '0233 preflight: expected exactly one Philip Vasan primary-address row, found %',
      v_primary_count;
  END IF;

  IF v_blackrock_count <> 0
     AND (v_blackrock_count <> 1 OR v_blackrock_valid_count <> 1) THEN
    RAISE EXCEPTION
      '0233 preflight: BlackRock address is already owned by an unexpected CRM email row';
  END IF;

  IF v_audit_count = 0 THEN
    IF v_subscribe_targets <> 95 OR v_unsubscribe_targets <> 9 THEN
      RAISE EXCEPTION
        '0233 preflight: expected 95 subscribe and 9 unsubscribe targets; found % and %',
        v_subscribe_targets, v_unsubscribe_targets;
    END IF;
  ELSIF v_audit_count = 1 THEN
    IF v_subscribe_targets <> 0 OR v_unsubscribe_targets <> 0 THEN
      RAISE EXCEPTION
        '0233 preflight: reconciliation audit exists but % subscribe and % unsubscribe targets remain',
        v_subscribe_targets, v_unsubscribe_targets;
    END IF;
  ELSE
    RAISE EXCEPTION
      '0233 preflight: found % reconciliation audit rows; expected exactly zero or one',
      v_audit_count;
  END IF;
END $$;

-- Derive one target per person. The preflight rejects any person with both
-- target states. source_current_subscriber is deliberately tested first.
WITH matched AS (
  SELECT
    p.id AS person_id,
    CASE
      WHEN nc.source_current_subscriber THEN 'subscribed'
      WHEN nc.source_unsubscribed THEN 'unsubscribed'
    END AS flodesk_status
  FROM newsletter_contacts nc
  JOIN emails e ON lower(btrim(e.email)) = nc.normalized_email
  JOIN people p ON p.id = e.person_id
  WHERE e.person_id IS NOT NULL
    AND (nc.source_current_subscriber OR nc.source_unsubscribed)
),
targets AS (
  SELECT
    person_id,
    bool_or(flodesk_status = 'subscribed') AS newsletter,
    NOT bool_or(flodesk_status = 'subscribed') AS unsubscribed_to_newsletter
  FROM matched
  GROUP BY person_id
)
UPDATE people p
SET newsletter = t.newsletter,
    unsubscribed_to_newsletter = t.unsubscribed_to_newsletter,
    updated_at = now()
FROM targets t
WHERE p.id = t.person_id
  AND (
    p.newsletter IS DISTINCT FROM t.newsletter
    OR p.unsubscribed_to_newsletter IS DISTINCT FROM t.unsubscribed_to_newsletter
  );

-- The deterministic id follows existing migration-created email rows. It makes
-- the insert safe to re-run while the lower(email) uniqueness preflight prevents
-- taking an address already owned elsewhere.
INSERT INTO emails (
  id, email, person_id, validity, is_preferred, created_at, updated_at
)
SELECT
  'em_0233_philip_vasan_blackrock',
  'philip.vasan@blackrock.com',
  'recMWdUfgt0ypOtnw',
  'unknown',
  false,
  now(),
  now()
WHERE NOT EXISTS (
  SELECT 1
  FROM emails
  WHERE lower(email) = lower('philip.vasan@blackrock.com')
);

-- The owner-confirmed existing Vasan address is the sole preferred address.
UPDATE emails
SET is_preferred = CASE
      WHEN lower(email) = lower('philip@vasan.com') THEN true
      ELSE false
    END,
    updated_at = now()
WHERE person_id = 'recMWdUfgt0ypOtnw'
  AND lower(email) IN (
    lower('philip@vasan.com'),
    lower('philip.vasan@blackrock.com')
  )
  AND is_preferred IS DISTINCT FROM CASE
    WHEN lower(email) = lower('philip@vasan.com') THEN true
    ELSE false
  END;

UPDATE newsletter_contacts
SET email_id = 'em_0233_philip_vasan_blackrock',
    updated_at = now()
WHERE normalized_email = 'philip.vasan@blackrock.com'
  AND email_id IS DISTINCT FROM 'em_0233_philip_vasan_blackrock';

UPDATE newsletter_engagement
SET email_id = 'em_0233_philip_vasan_blackrock',
    updated_at = now()
WHERE normalized_email = 'philip.vasan@blackrock.com'
  AND email_id IS DISTINCT FROM 'em_0233_philip_vasan_blackrock';

-- One immutable, idempotent business audit summary for the whole reconciliation.
INSERT INTO audit_log (
  id, actor_user_id, action, entity_type, entity_id, summary, changes, metadata, created_at
)
VALUES (
  'audit_0233_flodesk_subscription_reconciliation',
  NULL,
  'bulk_update',
  'newsletter_reconciliation',
  'flodesk-exact-email-and-philip-vasan',
  'Reconciled CRM newsletter status to current Flodesk exact-email evidence and linked Philip Vasan''s confirmed BlackRock secondary email',
  NULL,
  jsonb_build_object(
    'migration', '0233_reconcile_flodesk_subscription_statuses_and_philip_vasan_email',
    'source', 'imported_flodesk_evidence',
    'statusPrecedence', 'source_current_subscriber_then_source_unsubscribed',
    'before', jsonb_build_object(
      'subscribeTargets', 95,
      'unsubscribeTargets', 9,
      'exactEmailSubscriptionDifferences', 104
    ),
    'after', jsonb_build_object(
      'exactEmailSubscriptionDifferences', 0
    ),
    'philipVasan', jsonb_build_object(
      'personId', 'recMWdUfgt0ypOtnw',
      'primaryEmail', 'philip@vasan.com',
      'secondaryEmail', 'philip.vasan@blackrock.com',
      'secondaryEmailId', 'em_0233_philip_vasan_blackrock',
      'linkedNewsletterContact', true,
      'linkedNewsletterEngagementEvidence', true
    )
  ),
  now()
)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  v_remaining_discrepancies integer;
  v_philip_email_count integer;
  v_primary_ok_count integer;
  v_blackrock_email_count integer;
  v_other_preferred_count integer;
  v_blackrock_contact_count integer;
  v_blackrock_contact_linked_count integer;
  v_blackrock_engagement_count integer;
  v_blackrock_engagement_linked_count integer;
  v_matching_audit_count integer;
BEGIN
  WITH matched AS (
    SELECT
      CASE
        WHEN nc.source_current_subscriber THEN 'subscribed'
        WHEN nc.source_unsubscribed THEN 'unsubscribed'
      END AS flodesk_status,
      p.newsletter,
      p.unsubscribed_to_newsletter
    FROM newsletter_contacts nc
    JOIN emails e ON lower(btrim(e.email)) = nc.normalized_email
    JOIN people p ON p.id = e.person_id
    WHERE e.person_id IS NOT NULL
      AND (nc.source_current_subscriber OR nc.source_unsubscribed)
  )
  SELECT count(*)::integer
    INTO v_remaining_discrepancies
    FROM matched
   WHERE (flodesk_status = 'subscribed'
          AND (NOT newsletter OR unsubscribed_to_newsletter))
      OR (flodesk_status = 'unsubscribed'
          AND (newsletter OR NOT unsubscribed_to_newsletter));

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE lower(email) = lower('philip@vasan.com') AND is_preferred
    )::integer,
    count(*) FILTER (
      WHERE lower(email) = lower('philip.vasan@blackrock.com')
        AND NOT is_preferred
    )::integer,
    count(*) FILTER (
      WHERE lower(email) <> lower('philip@vasan.com') AND is_preferred
    )::integer
  INTO
    v_philip_email_count,
    v_primary_ok_count,
    v_blackrock_email_count,
    v_other_preferred_count
  FROM emails
  WHERE person_id = 'recMWdUfgt0ypOtnw';

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE email_id = 'em_0233_philip_vasan_blackrock'
    )::integer
  INTO v_blackrock_contact_count, v_blackrock_contact_linked_count
  FROM newsletter_contacts
  WHERE normalized_email = 'philip.vasan@blackrock.com';

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE email_id = 'em_0233_philip_vasan_blackrock'
    )::integer
  INTO v_blackrock_engagement_count, v_blackrock_engagement_linked_count
  FROM newsletter_engagement
  WHERE normalized_email = 'philip.vasan@blackrock.com';

  SELECT count(*)::integer
    INTO v_matching_audit_count
    FROM audit_log
   WHERE id = 'audit_0233_flodesk_subscription_reconciliation'
     AND entity_type = 'newsletter_reconciliation'
     AND metadata ->> 'migration'
         = '0233_reconcile_flodesk_subscription_statuses_and_philip_vasan_email'
     AND metadata #>> '{after,exactEmailSubscriptionDifferences}' = '0';

  IF v_remaining_discrepancies <> 0 THEN
    RAISE EXCEPTION
      '0233 postflight: % exact-email Flodesk/CRM subscription discrepancies remain',
      v_remaining_discrepancies;
  END IF;

  IF v_philip_email_count <> 2
     OR v_primary_ok_count <> 1
     OR v_blackrock_email_count <> 1
     OR v_other_preferred_count <> 0 THEN
    RAISE EXCEPTION
      '0233 postflight: Philip email state invalid (emails=% primary_ok=% blackrock_secondary=% other_preferred=%)',
      v_philip_email_count, v_primary_ok_count, v_blackrock_email_count,
      v_other_preferred_count;
  END IF;

  IF v_blackrock_contact_count <> 1
     OR v_blackrock_contact_linked_count <> 1 THEN
    RAISE EXCEPTION
      '0233 postflight: BlackRock newsletter contact is not uniquely linked';
  END IF;

  IF v_blackrock_engagement_count <> v_blackrock_engagement_linked_count THEN
    RAISE EXCEPTION
      '0233 postflight: BlackRock newsletter engagement evidence is not fully linked (% of %)',
      v_blackrock_engagement_linked_count, v_blackrock_engagement_count;
  END IF;

  IF v_matching_audit_count <> 1 THEN
    RAISE EXCEPTION
      '0233 postflight: expected one matching reconciliation audit entry, found %',
      v_matching_audit_count;
  END IF;

  RAISE NOTICE
    '0233: Flodesk reconciliation verified (0 discrepancies; Philip primary/secondary emails and evidence links complete)';
END $$;
