-- 0230: Focus the existing Grant Leads queue and group reviewed re-announcements.
--
-- The old deterministic email detector admitted shopping promotions, RFP
-- templates/guides, application decisions, quoted reply tails, and image-only
-- fragments. It also gave each re-announcement a deadline/title/URL-sensitive
-- identity, so repeat emails about the same program became separate rows.
--
-- Safe/idempotent: false positives are archived (not deleted); the grouping
-- rules cover only three manually reviewed named programs, retain one active
-- row, move every distinct source-email sighting to it, and archive the other
-- rows. Re-running finds no additional active duplicates.
--
-- Apply to BOTH development and production from the repository root:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0230_focus_and_group_grant_leads.sql
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0230_focus_and_group_grant_leads.sql

UPDATE grant_leads
SET status = 'archived',
    archived_at = COALESCE(archived_at, now()),
    updated_at = now()
WHERE status IN ('new', 'claimed')
  AND (
    lower(concat_ws(' ', title, snippet)) ~
      '(shop now|free shipping|[0-9]+% off|percent off|sale ends|birthday week)'
    OR lower(concat_ws(' ', title, snippet)) ~
      '(rfp|request for proposals).{0,100}(template|guide|sample|checklist|download)'
    OR lower(concat_ws(' ', title, snippet)) ~
      '(template|guide|sample|checklist|download).{0,100}(rfp|request for proposals)'
    OR lower(title) ~ '(submission|application|proposal) decision'
    OR lower(title) ~ '^view image(\s|:|$)'
    OR lower(title) ~ '^on .{1,240}(wrote:|<)'
    OR lower(title) ~ '^opinion:'
    OR lower(title) ~ '^https?://'
    OR lower(title) ~ '^(event date|register now|save the date)'
    OR lower(title) ~ '(product update|release notes|new feature)'
    OR lower(title) ~ '^gartner is now predicting'
    OR (
      lower(title) ~ '(webinar|information session)'
      AND lower(concat_ws(' ', title, snippet)) !~
        '(accepting applications|applications? (are )?(now )?open|apply (now|today|by|here|online)|request for proposals|call for (proposals|applications)|letter of (inquiry|interest)|loi deadline)'
    )
  );

DO $$
DECLARE
  grouping record;
  keeper_id text;
  duplicate_ids text[];
BEGIN
  FOR grouping IN
    SELECT *
    FROM (VALUES
      (
        'grant:program:cummings $35 million grant program',
        '%cummings%',
        '%35 million grant%',
        NULL::text
      ),
      (
        'grant:program:camelback fellowship',
        '%camelback%',
        '%fellowship%',
        NULL::text
      ),
      (
        'grant:program:minneapolis climate action and racial equity fund',
        '%minneapolis%',
        '%climate action%',
        '%racial equity%'
      )
    ) AS reviewed(target_key, pattern_a, pattern_b, pattern_c)
  LOOP
    SELECT id
    INTO keeper_id
    FROM grant_leads
    WHERE status IN ('new', 'claimed')
      AND concat_ws(' ', title, funder_name, snippet) ILIKE grouping.pattern_a
      AND concat_ws(' ', title, funder_name, snippet) ILIKE grouping.pattern_b
      AND (
        grouping.pattern_c IS NULL
        OR concat_ws(' ', title, funder_name, snippet) ILIKE grouping.pattern_c
      )
    ORDER BY
      (dedupe_key = grouping.target_key) DESC,
      (status = 'claimed') DESC,
      length(COALESCE(snippet, '')) DESC,
      created_at ASC,
      id ASC
    LIMIT 1;

    IF keeper_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT array_agg(id ORDER BY id)
    INTO duplicate_ids
    FROM grant_leads
    WHERE status IN ('new', 'claimed')
      AND id <> keeper_id
      AND concat_ws(' ', title, funder_name, snippet) ILIKE grouping.pattern_a
      AND concat_ws(' ', title, funder_name, snippet) ILIKE grouping.pattern_b
      AND (
        grouping.pattern_c IS NULL
        OR concat_ws(' ', title, funder_name, snippet) ILIKE grouping.pattern_c
      );

    IF COALESCE(cardinality(duplicate_ids), 0) > 0 THEN
      -- Archive first so the active partial unique index cannot conflict when
      -- the survivor receives the new semantic identity.
      UPDATE grant_leads
      SET status = 'archived',
          archived_at = COALESCE(archived_at, now()),
          updated_at = now()
      WHERE id = ANY(duplicate_ids);

      -- Deduplicate across the entire cluster (not only survivor-vs-duplicate)
      -- before moving rows. Otherwise the same Gmail message appearing on two
      -- duplicate leads could collide with the unique index during UPDATE.
      WITH ranked_sightings AS (
        SELECT
          id,
          row_number() OVER (
            PARTITION BY
              mailbox_user_id,
              CASE
                WHEN gmail_message_id IS NOT NULL THEN 'gmail:' || gmail_message_id
                WHEN email_message_id IS NOT NULL THEN 'email:' || email_message_id
                ELSE 'sighting:' || id
              END
            ORDER BY (grant_lead_id = keeper_id) DESC, created_at ASC, id ASC
          ) AS occurrence
        FROM grant_lead_sightings
        WHERE grant_lead_id = keeper_id
           OR grant_lead_id = ANY(duplicate_ids)
      )
      DELETE FROM grant_lead_sightings
      WHERE id IN (
        SELECT id FROM ranked_sightings WHERE occurrence > 1
      );

      UPDATE grant_lead_sightings
      SET grant_lead_id = keeper_id
      WHERE grant_lead_id = ANY(duplicate_ids);
    END IF;

    UPDATE grant_leads
    SET dedupe_key = grouping.target_key,
        updated_at = now()
    WHERE id = keeper_id
      AND dedupe_key <> grouping.target_key;
  END LOOP;
END
$$;
