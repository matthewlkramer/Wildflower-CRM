-- 0234: Add and link 29 resolved or owner-confirmed Flodesk subscriber emails.
--
-- WHY: These imported current-subscriber addresses did not exactly match an
-- existing CRM email. A read-only identity-resolution review plus owner confirmation identified 29
-- people using first-name agreement plus a distinctive first+last,
-- first-initial+last, surname, or corroborated historical-message pattern.
--
-- SAFE / IDEMPOTENT:
--   * requires migration 0233 to have been applied first;
--   * aborts unless all 29 reviewed people and Flodesk contacts are present;
--   * aborts if any address is already owned by an unexpected CRM record;
--   * inserts deterministic email ids, links all imported evidence, and records
--     one immutable audit entry;
--   * preserves existing preferred-email choices and makes the new address
--     preferred only when the person previously had no email;
--   * applies current Flodesk subscriber status except for the owner-confirmed
--     deceased person, who remains unsubscribed;
--   * accepts only the fully completed post-state on re-run.
--
-- Production is human-applied from the repository root:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0234_add_resolved_flodesk_subscriber_emails.sql
--
-- Do not add BEGIN/COMMIT: psql -1 owns the transaction.

CREATE TEMP TABLE m0234_targets (
  email_id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  person_id text NOT NULL UNIQUE,
  person_name text NOT NULL,
  email_type email_type NOT NULL,
  email_validity contact_validity NOT NULL,
  target_newsletter boolean NOT NULL,
  target_unsubscribed boolean NOT NULL,
  mark_deceased boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO m0234_targets (
  email_id, email, person_id, person_name, email_type, email_validity,
  target_newsletter, target_unsubscribed, mark_deceased
)
VALUES
  ('em_0234_ashley_beckner', 'abeckner@imaginablefutures.com', 'reccW5M97FrvY4t1C', 'Ashley Beckner', 'work', 'invalid', true, false, false),
  ('em_0234_amy_gips', 'amy.gips@wildflowerschools.org', 'recV86TdJUORXwIXo', 'Amy Gips', 'work', 'unknown', true, false, false),
  ('em_0234_annie_knickman_plancher', 'aplancher@socialfinance.org', 'recW7o5L76aVKfkO3', 'Annie Knickman Plancher', 'work', 'invalid', true, false, false),
  ('em_0234_caitlin_codella_low', 'ccodellalow@bipartisanpolicy.org', 'rec2wm588EbXYcaQZ', 'Caitlin Codella Low', 'work', 'unknown', true, false, false),
  ('em_0234_daniela_vasan', 'daniela.vasan@wildflowerschools.org', 'recy3Qtsjxrwg6lwc', 'Daniela Vasan', 'work', 'unknown', true, false, false),
  ('em_0234_erica_cantoni', 'erica.cantoni@wildflowerschools.org', 'reczTuMKDMJjQpg5z', 'Erica Cantoni', 'work', 'unknown', true, false, false),
  ('em_0234_greg_klein', 'gregklein411@gmail.com', 'rectjlyODZwwxxZ55', 'Greg Klein', 'personal', 'unknown', true, false, false),
  ('em_0234_jim_mccormick', 'jmccormick@fmcg.com', 'recrhfXZW2EZTEgmx', 'Jim McCormick', 'work', 'invalid', true, false, false),
  ('em_0234_jennifer_paradis', 'jparadis@chappellculper.org', 'recXLCZUJo018UsbY', 'Jennifer Paradis', 'work', 'unknown', true, false, false),
  ('em_0234_kumar_garg', 'kgarg@schmidtfutures.com', 'rec7dv71iAMQMH2OA', 'Kumar Garg', 'work', 'invalid', true, false, false),
  ('em_0234_maia_blankenship', 'maia.blankenship@wildflowerschools.org', 'recUdeGVQKlHczo79', 'Maia Blankenship', 'work', 'unknown', true, false, false),
  ('em_0234_marissa_bazan', 'mbazan@arnoldfoundation.org', 'recD0ZKWfhBdkwVZw', 'Marissa Bazan', 'work', 'unknown', true, false, false),
  ('em_0234_marc_chun', 'mchun@hewlett.org', 'reczhZTtV2PIhW8oh', 'Marc Chun', 'work', 'unknown', true, false, false),
  ('em_0234_melanie_dukes', 'mdukes@overdeck.org', 'recVNldVoMfPM6Guc', 'Melanie Dukes', 'work', 'unknown', true, false, false),
  ('em_0234_paul_keys', 'paul.keys@teachforamerica.org', 'reciVVVohw6twAfbl', 'Paul Keys', 'work', 'unknown', true, false, false),
  ('em_0234_rachel_kelley_cohn', 'rachel.kelley-cohn@wildflowerschools.org', 'recOv0gHw668eE3hO', 'Rachel Kelley-Cohn', 'work', 'unknown', true, false, false),
  ('em_0234_rena_johnson', 'rjohnson@citybridge.org', 'recKfF2acoPhmFA0q', 'Rena Johnson', 'work', 'invalid', true, false, false),
  ('em_0234_sunny_greenberg', 'sunny.greenberg@wildflowerschools.org', 'recbbWOl6Xz2t2jM0', 'Sunny Greenberg', 'work', 'unknown', true, false, false),
  ('em_0234_ted_quinn', 'ted.quinn@covariantgroup.com', 'rec5rOo1sEIAUBLd3', 'Ted Quinn', 'work', 'unknown', true, false, false),
  ('em_0234_tiffany_cuellar_needham', 'tiffany.needham@teachforamerica.org', 'rec6YLMdIXlxGhCsu', 'Tiffany Cuellar Needham', 'work', 'unknown', true, false, false),
  ('em_0234_ericca_maas', 'maas@closegapsby5.org', 'recPnOdczEygtkC0b', 'Ericca Maas', 'work', 'unknown', true, false, false),
  ('em_0234_jim_frey', 'jim@freyfoundationmn.org', 'rec9wltZqjbw86ABv', 'Jim Frey', 'work', 'unknown', true, false, false),
  ('em_0234_hassan_hassan', 'hassan@4pt0.org', 'recl5ZY8ZcdBflDzU', 'Hassan Hassan', 'work', 'invalid', true, false, false),
  ('em_0234_bob_scully', 'scullyr@gmail.com', 'recwTfTiygjGC8lyw', 'Bob Scully', 'personal', 'unknown', true, false, false),
  ('em_0234_brooke_stafford_brizard', 'brooke@chanzuckerberg.com', 'recXlZX81Ehuq2Rad', 'Brooke Stafford-Brizard', 'work', 'invalid', true, false, false),
  ('em_0234_shavar_jeffries', 'shavar@dfer.org', 'rec71PKNRdoOSWokB', 'Shavar Jeffries', 'work', 'invalid', true, false, false),
  ('em_0234_john_arnold', 'john@arnoldfoundation.org', 'rec8IAStTAcJRKNWU', 'John Arnold', 'work', 'unknown', true, false, false),
  ('em_0234_laverne_srinivasan', 'lesrinivasan@gmail.com', 'recG7cld4F9uZKm0W', 'LaVerne Srinivasan', 'personal', 'unknown', true, false, false),
  ('em_0234_michael_dorer', 'mjdorer@gmail.com', 'rec0wXrIUSu3ovTRN', 'Michael Dorer', 'personal', 'invalid', false, true, true);

DO $$
DECLARE
  v_target_count integer;
  v_dependency_count integer;
  v_active_people integer;
  v_contact_count integer;
  v_wrong_contact_links integer;
  v_existing_email_rows integer;
  v_correct_email_rows integer;
  v_audit_count integer;
BEGIN
  SELECT count(*)::integer INTO v_target_count FROM m0234_targets;

  SELECT count(*)::integer
    INTO v_dependency_count
    FROM audit_log
   WHERE id = 'audit_0233_flodesk_subscription_reconciliation';

  SELECT count(*)::integer
    INTO v_active_people
    FROM m0234_targets t
    JOIN people p ON p.id = t.person_id
   WHERE p.archived_at IS NULL;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE nc.email_id IS NOT NULL AND nc.email_id <> t.email_id
    )::integer
  INTO v_contact_count, v_wrong_contact_links
  FROM m0234_targets t
  JOIN newsletter_contacts nc ON nc.normalized_email = t.email
  WHERE nc.source_current_subscriber;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE e.id = t.email_id
        AND e.person_id = t.person_id
        AND e.organization_id IS NULL
        AND e.payment_intermediary_id IS NULL
        AND e.household_id IS NULL
    )::integer
  INTO v_existing_email_rows, v_correct_email_rows
  FROM m0234_targets t
  JOIN emails e ON lower(btrim(e.email)) = t.email;

  SELECT count(*)::integer
    INTO v_audit_count
    FROM audit_log
   WHERE id = 'audit_0234_resolved_flodesk_subscriber_emails';

  IF v_target_count <> 29 THEN
    RAISE EXCEPTION '0234 preflight: expected 29 target rows, found %', v_target_count;
  END IF;

  IF v_dependency_count <> 1 THEN
    RAISE EXCEPTION
      '0234 preflight: migration 0233 must be applied first (dependency audit rows=%)',
      v_dependency_count;
  END IF;

  IF v_active_people <> 29 THEN
    RAISE EXCEPTION
      '0234 preflight: expected 29 active reviewed people, found %',
      v_active_people;
  END IF;

  IF v_contact_count <> 29 OR v_wrong_contact_links <> 0 THEN
    RAISE EXCEPTION
      '0234 preflight: Flodesk contact state invalid (current contacts=% wrong links=%)',
      v_contact_count, v_wrong_contact_links;
  END IF;

  IF v_existing_email_rows <> v_correct_email_rows THEN
    RAISE EXCEPTION
      '0234 preflight: % target address(es) are owned by unexpected CRM email rows',
      v_existing_email_rows - v_correct_email_rows;
  END IF;

  IF v_audit_count = 0 THEN
    IF v_existing_email_rows <> 0 THEN
      RAISE EXCEPTION
        '0234 preflight: expected no target email rows before first run; found %',
        v_existing_email_rows;
    END IF;
  ELSIF v_audit_count = 1 THEN
    IF v_correct_email_rows <> 29 THEN
      RAISE EXCEPTION
        '0234 preflight: audit exists but only % of 29 target emails are complete',
        v_correct_email_rows;
    END IF;
  ELSE
    RAISE EXCEPTION
      '0234 preflight: expected zero or one audit row, found %',
      v_audit_count;
  END IF;
END $$;

INSERT INTO emails (
  id, email, person_id, type, validity, is_preferred, created_at, updated_at
)
SELECT
  t.email_id,
  t.email,
  t.person_id,
  t.email_type,
  t.email_validity,
  NOT EXISTS (
    SELECT 1 FROM emails current_email WHERE current_email.person_id = t.person_id
  ),
  now(),
  now()
FROM m0234_targets t
WHERE NOT EXISTS (
  SELECT 1 FROM emails existing WHERE lower(btrim(existing.email)) = t.email
)
ON CONFLICT (id) DO NOTHING;

UPDATE newsletter_contacts nc
SET email_id = t.email_id,
    updated_at = now()
FROM m0234_targets t
WHERE nc.normalized_email = t.email
  AND nc.email_id IS DISTINCT FROM t.email_id;

UPDATE newsletter_engagement ne
SET email_id = t.email_id,
    updated_at = now()
FROM m0234_targets t
WHERE ne.normalized_email = t.email
  AND ne.email_id IS DISTINCT FROM t.email_id;

UPDATE people p
SET newsletter = t.target_newsletter,
    unsubscribed_to_newsletter = t.target_unsubscribed,
    deceased = CASE WHEN t.mark_deceased THEN true ELSE p.deceased END,
    updated_at = now()
FROM m0234_targets t
WHERE p.id = t.person_id
  AND (
    p.newsletter IS DISTINCT FROM t.target_newsletter
    OR p.unsubscribed_to_newsletter IS DISTINCT FROM t.target_unsubscribed
    OR (t.mark_deceased AND NOT p.deceased)
  );

INSERT INTO audit_log (
  id, actor_user_id, action, entity_type, entity_id, summary, changes, metadata, created_at
)
VALUES (
  'audit_0234_resolved_flodesk_subscriber_emails',
  NULL,
  'bulk_update',
  'newsletter_reconciliation',
  'flodesk-name-and-email-resolution',
  'Added and linked 29 resolved or owner-confirmed Flodesk subscriber emails to existing CRM people',
  NULL,
  jsonb_build_object(
    'migration', '0234_add_resolved_flodesk_subscriber_emails',
    'source', 'imported_flodesk_evidence',
    'matchCount', 29,
    'newsletterPeopleReconciled', 29,
    'invalidEmailCount', 9,
    'deceasedPeopleMarked', 1,
    'matchRule', 'conservative identity resolution plus owner-confirmed historical addresses',
    'preservedAmbiguousMatches', true,
    'linkedNewsletterContacts', true,
    'linkedNewsletterEngagementEvidence', true
  ),
  now()
)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  v_correct_emails integer;
  v_linked_contacts integer;
  v_status_ok integer;
  v_engagement_rows integer;
  v_linked_engagement_rows integer;
  v_audit_count integer;
BEGIN
  SELECT count(*)::integer
    INTO v_correct_emails
    FROM m0234_targets t
    JOIN emails e ON lower(btrim(e.email)) = t.email
   WHERE e.id = t.email_id
     AND e.person_id = t.person_id
     AND e.organization_id IS NULL
     AND e.payment_intermediary_id IS NULL
     AND e.household_id IS NULL;

  SELECT count(*)::integer
    INTO v_linked_contacts
    FROM m0234_targets t
    JOIN newsletter_contacts nc ON nc.normalized_email = t.email
   WHERE nc.email_id = t.email_id;

  SELECT count(*)::integer
    INTO v_status_ok
    FROM m0234_targets t
    JOIN people p ON p.id = t.person_id
   WHERE p.newsletter IS NOT DISTINCT FROM t.target_newsletter
     AND p.unsubscribed_to_newsletter IS NOT DISTINCT FROM t.target_unsubscribed
     AND (NOT t.mark_deceased OR p.deceased);

  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE ne.email_id = t.email_id)::integer
  INTO v_engagement_rows, v_linked_engagement_rows
  FROM m0234_targets t
  JOIN newsletter_engagement ne ON ne.normalized_email = t.email;

  SELECT count(*)::integer
    INTO v_audit_count
    FROM audit_log
   WHERE id = 'audit_0234_resolved_flodesk_subscriber_emails'
     AND entity_type = 'newsletter_reconciliation'
     AND metadata ->> 'migration' = '0234_add_resolved_flodesk_subscriber_emails'
     AND metadata ->> 'matchCount' = '29';

  IF v_correct_emails <> 29
     OR v_linked_contacts <> 29
     OR v_status_ok <> 29
     OR v_engagement_rows <> v_linked_engagement_rows
     OR v_audit_count <> 1 THEN
    RAISE EXCEPTION
      '0234 postflight failed (emails=% contacts=% statuses=% engagement=%/% audit=%)',
      v_correct_emails, v_linked_contacts, v_status_ok,
      v_linked_engagement_rows, v_engagement_rows, v_audit_count;
  END IF;

  RAISE NOTICE
    '0234: verified 29 resolved emails, contacts, engagement links, and newsletter states';
END $$;
