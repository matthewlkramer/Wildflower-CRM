# Runbook — Flodesk subscription reconciliation and Philip Vasan email link

## Purpose

This is a **data-only** production migration. It applies the owner-ratified
operational rule to the already imported Flodesk source evidence:

- current Flodesk subscriber → `people.newsletter = true` and
  `people.unsubscribed_to_newsletter = false`;
- otherwise, Flodesk historical-unsubscribe evidence → `people.newsletter = false`
  and `people.unsubscribed_to_newsletter = true`;
- `source_current_subscriber = true` has priority when a contact also has historical
  unsubscribe evidence.

It only uses exact normalized-email matches from `newsletter_contacts` to `emails`
owned by a person. It also adds Philip Vasan's confirmed BlackRock address as a
non-preferred secondary address, makes `philip@vasan.com` preferred, links the
BlackRock newsletter contact/engagement evidence, and records one `audit_log` row.

No application code or schema Publish is required: the newsletter tables and email
schema are already present in production.

## Safety and idempotency

- The SQL contains no `BEGIN` or `COMMIT`; `psql -1` owns one all-or-nothing
  transaction.
- Before its first application, it aborts unless there are exactly **95**
  subscribe targets and **9** unsubscribe targets, and no person has conflicting
  derived states across exact-email matches.
- It aborts if Philip's existing address is not uniquely owned by the expected
  person or if the BlackRock address is already owned by another record.
- A successful re-run changes zero records. It requires zero remaining
  discrepancies and the one deterministic audit row from this migration.
- Any failed assertion rolls back the entire transaction.

## Read-only preflight

Run this from the repository root. It must report 95 subscribe targets, 9
unsubscribe targets, and 0 ambiguous people before first apply:

```bash
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -c "
WITH matched AS (
  SELECT p.id AS person_id,
         CASE WHEN nc.source_current_subscriber THEN 'subscribed'
              WHEN nc.source_unsubscribed THEN 'unsubscribed' END AS flodesk_status,
         p.newsletter, p.unsubscribed_to_newsletter
  FROM newsletter_contacts nc
  JOIN emails e ON lower(btrim(e.email)) = nc.normalized_email
  JOIN people p ON p.id = e.person_id
  WHERE e.person_id IS NOT NULL
    AND (nc.source_current_subscriber OR nc.source_unsubscribed)
),
per_person AS (
  SELECT person_id,
         bool_or(flodesk_status = 'subscribed') AS has_subscribed_status,
         bool_or(flodesk_status = 'unsubscribed') AS has_unsubscribed_status,
         bool_or(flodesk_status = 'subscribed'
           AND (NOT newsletter OR unsubscribed_to_newsletter)) AS needs_subscribed_update,
         bool_or(flodesk_status = 'unsubscribed'
           AND (newsletter OR NOT unsubscribed_to_newsletter)) AS needs_unsubscribed_update
  FROM matched
  GROUP BY person_id
)
SELECT
  count(*) FILTER (WHERE needs_subscribed_update AND NOT needs_unsubscribed_update)
    AS subscribe_targets,
  count(*) FILTER (WHERE needs_unsubscribed_update AND NOT needs_subscribed_update)
    AS unsubscribe_targets,
  count(*) FILTER (WHERE has_subscribed_status AND has_unsubscribed_status)
    AS ambiguous_people
FROM per_person;
"
```

Also confirm the source evidence is present and that no existing global CRM email
owns the BlackRock address:

```bash
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT normalized_email, email_id
FROM newsletter_contacts
WHERE normalized_email = 'philip.vasan@blackrock.com';

SELECT id, email, person_id, is_preferred
FROM emails
WHERE lower(email) IN (
  lower('philip@vasan.com'),
  lower('philip.vasan@blackrock.com')
)
ORDER BY lower(email);
"
```

## Apply to production

Only a human applies production data migrations. From the repository root:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0233_reconcile_flodesk_subscription_statuses_and_philip_vasan_email.sql
```

Expected successful output includes:

```text
NOTICE:  0233: Flodesk reconciliation verified (0 discrepancies; Philip primary/secondary emails and evidence links complete)
```

## Postflight verification

The migration performs these assertions before commit. Re-run the following
read-only query afterward for an independently visible report:

```bash
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -c "
WITH matched AS (
  SELECT CASE WHEN nc.source_current_subscriber THEN 'subscribed'
              WHEN nc.source_unsubscribed THEN 'unsubscribed' END AS flodesk_status,
         p.newsletter, p.unsubscribed_to_newsletter
  FROM newsletter_contacts nc
  JOIN emails e ON lower(btrim(e.email)) = nc.normalized_email
  JOIN people p ON p.id = e.person_id
  WHERE e.person_id IS NOT NULL
    AND (nc.source_current_subscriber OR nc.source_unsubscribed)
)
SELECT count(*) AS remaining_exact_email_discrepancies
FROM matched
WHERE (flodesk_status = 'subscribed'
       AND (NOT newsletter OR unsubscribed_to_newsletter))
   OR (flodesk_status = 'unsubscribed'
       AND (newsletter OR NOT unsubscribed_to_newsletter));

SELECT id, email, is_preferred, validity, person_id
FROM emails
WHERE person_id = 'recMWdUfgt0ypOtnw'
ORDER BY is_preferred DESC, lower(email);

SELECT
  (SELECT email_id
   FROM newsletter_contacts
   WHERE normalized_email = 'philip.vasan@blackrock.com') AS contact_email_id,
  count(*) AS blackrock_engagement_rows,
  count(*) FILTER (WHERE email_id = 'em_0233_philip_vasan_blackrock')
    AS linked_blackrock_engagement_rows
FROM newsletter_engagement
WHERE normalized_email = 'philip.vasan@blackrock.com';

SELECT id, summary, metadata, created_at
FROM audit_log
WHERE id = 'audit_0233_flodesk_subscription_reconciliation';
"
```

Expected postflight state:

- `remaining_exact_email_discrepancies = 0`;
- Philip has exactly two addresses: `philip@vasan.com` is preferred and
  `philip.vasan@blackrock.com` is not;
- the BlackRock contact and every BlackRock engagement row carry
  `em_0233_philip_vasan_blackrock`;
- exactly one audit row exists with id
  `audit_0233_flodesk_subscription_reconciliation`.

## Re-run behavior

After a successful apply, repeat the exact production apply command. It should
produce the same verification notice and make no record changes. It will abort if
someone later changes a derived CRM subscription state, breaks Philip's two-email
state, unlinks the BlackRock evidence, or removes/changes the migration audit row.

## Rollback guidance

Do not manually reverse this migration without a new reviewed migration. The
previous CRM newsletter fields were intentionally reconciled to owner-ratified
Flodesk evidence, and the migration audit retains only aggregate preflight counts,
not a per-person historical snapshot.

If a rollback is necessary:

1. Stop and identify the corrected authoritative evidence or owner decision.
2. Prepare a new, separately numbered, reviewed, idempotent migration that targets
   only the affected people and records its own audit entry.
3. Do not delete the BlackRock email or existing audit row casually; inspect whether
   later CRM activity now references them.