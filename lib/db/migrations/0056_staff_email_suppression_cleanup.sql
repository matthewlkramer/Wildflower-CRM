-- 0056_staff_email_suppression_cleanup
--
-- Retroactively enforce STAFF-DEFAULT permanent sync suppression on existing
-- email_messages and calendar_events.
--
-- Rule (mirrors emailMatcher.ts loadStaffDefaultSuppressedPersonIds): a PERSON
-- who owns an internal-domain (Wildflower staff) email AND has NO explicit
-- suppression window is permanently suppressed from email/calendar sync. Such a
-- person must not appear in matched_person_ids on any synced row.
--
--   * email_messages that become fully unmatched (no remaining person AND no
--     org/household match) are moved to email_sync_skip then deleted — matching
--     the live skip-table semantics for unmatched mail.
--   * email_messages that still have another match keep the row, with the staff
--     person id(s) trimmed out of matched_person_ids.
--   * calendar_events are NEVER deleted (no skip table for calendar) — their
--     matched_person_ids is trimmed (set NULL when it becomes empty).
--
-- People WITH an explicit suppression window are intentionally untouched here:
-- a window overrides the staff default, and date-aware window cleanup is the job
-- of the backfill-sync-suppression script (prod currently has 0 windows).
--
-- Additive + idempotent: a second run finds nothing to do (staff ids are already
-- gone from the arrays; orphan rows are already deleted; skip inserts are
-- ON CONFLICT DO NOTHING). NO BEGIN/COMMIT — applied via `psql -1` which wraps
-- the whole file in one transaction.
--
-- Apply (production, by a human):
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0056_staff_email_suppression_cleanup.sql

-- ── (A) move now-orphaned staff emails into email_sync_skip ──────────────────
WITH dom AS (
  SELECT COALESCE(
           (SELECT domains FROM internal_email_domains WHERE id = 'singleton'),
           ARRAY['wildflowerschools.org', 'blackwildflowers.org']
         ) AS domains
),
staff AS (
  SELECT DISTINCT e.person_id
  FROM emails e, dom
  WHERE e.person_id IS NOT NULL
    AND lower(split_part(e.email, '@', 2)) = ANY (dom.domains)
    AND NOT EXISTS (
      SELECT 1 FROM person_suppression_windows w WHERE w.person_id = e.person_id
    )
),
staff_arr AS (
  SELECT COALESCE(array_agg(person_id), '{}'::text[]) AS ids FROM staff
),
orphans AS (
  SELECT m.*
  FROM email_messages m, staff_arr s
  WHERE m.matched_person_ids && s.ids
    AND cardinality(
          ARRAY(
            SELECT unnest(m.matched_person_ids)
            EXCEPT
            SELECT unnest(s.ids)
          )
        ) = 0
    AND COALESCE(cardinality(m.matched_organization_ids), 0) = 0
    AND COALESCE(cardinality(m.matched_household_ids), 0) = 0
)
INSERT INTO email_sync_skip
  (mailbox_user_id, gmail_message_id, from_addrs, to_addrs, cc_addrs, bcc_addrs,
   subject, sent_at)
SELECT
  o.mailbox_user_id,
  o.gmail_message_id,
  CASE
    WHEN o.from_email IS NOT NULL AND o.from_email <> ''
      THEN ARRAY[lower(o.from_email)]
    ELSE '{}'::text[]
  END,
  COALESCE((SELECT array_agg(lower(x)) FROM unnest(o.to_emails)  x
            WHERE x IS NOT NULL AND x <> ''), '{}'::text[]),
  COALESCE((SELECT array_agg(lower(x)) FROM unnest(o.cc_emails)  x
            WHERE x IS NOT NULL AND x <> ''), '{}'::text[]),
  COALESCE((SELECT array_agg(lower(x)) FROM unnest(o.bcc_emails) x
            WHERE x IS NOT NULL AND x <> ''), '{}'::text[]),
  o.subject,
  o.sent_at
FROM orphans o
ON CONFLICT (mailbox_user_id, gmail_message_id) DO NOTHING;

-- ── (B) delete those now-orphaned staff emails ──────────────────────────────
-- Must run AFTER (A) so the rows are preserved in the skip table first, and
-- BEFORE (C) so the orphan predicate still matches (C nulls the arrays).
WITH dom AS (
  SELECT COALESCE(
           (SELECT domains FROM internal_email_domains WHERE id = 'singleton'),
           ARRAY['wildflowerschools.org', 'blackwildflowers.org']
         ) AS domains
),
staff AS (
  SELECT DISTINCT e.person_id
  FROM emails e, dom
  WHERE e.person_id IS NOT NULL
    AND lower(split_part(e.email, '@', 2)) = ANY (dom.domains)
    AND NOT EXISTS (
      SELECT 1 FROM person_suppression_windows w WHERE w.person_id = e.person_id
    )
),
staff_arr AS (
  SELECT COALESCE(array_agg(person_id), '{}'::text[]) AS ids FROM staff
)
DELETE FROM email_messages m
USING staff_arr s
WHERE m.matched_person_ids && s.ids
  AND cardinality(
        ARRAY(
          SELECT unnest(m.matched_person_ids)
          EXCEPT
          SELECT unnest(s.ids)
        )
      ) = 0
  AND COALESCE(cardinality(m.matched_organization_ids), 0) = 0
  AND COALESCE(cardinality(m.matched_household_ids), 0) = 0;

-- ── (C) trim staff ids out of still-matched emails ──────────────────────────
WITH dom AS (
  SELECT COALESCE(
           (SELECT domains FROM internal_email_domains WHERE id = 'singleton'),
           ARRAY['wildflowerschools.org', 'blackwildflowers.org']
         ) AS domains
),
staff AS (
  SELECT DISTINCT e.person_id
  FROM emails e, dom
  WHERE e.person_id IS NOT NULL
    AND lower(split_part(e.email, '@', 2)) = ANY (dom.domains)
    AND NOT EXISTS (
      SELECT 1 FROM person_suppression_windows w WHERE w.person_id = e.person_id
    )
),
staff_arr AS (
  SELECT COALESCE(array_agg(person_id), '{}'::text[]) AS ids FROM staff
)
UPDATE email_messages m
SET matched_person_ids = NULLIF(
      ARRAY(
        SELECT unnest(m.matched_person_ids)
        EXCEPT
        SELECT unnest(s.ids)
      ),
      '{}'::text[]
    )
FROM staff_arr s
WHERE m.matched_person_ids && s.ids;

-- ── (D) trim staff ids out of calendar events (never deleted) ───────────────
WITH dom AS (
  SELECT COALESCE(
           (SELECT domains FROM internal_email_domains WHERE id = 'singleton'),
           ARRAY['wildflowerschools.org', 'blackwildflowers.org']
         ) AS domains
),
staff AS (
  SELECT DISTINCT e.person_id
  FROM emails e, dom
  WHERE e.person_id IS NOT NULL
    AND lower(split_part(e.email, '@', 2)) = ANY (dom.domains)
    AND NOT EXISTS (
      SELECT 1 FROM person_suppression_windows w WHERE w.person_id = e.person_id
    )
)
, staff_arr AS (
  SELECT COALESCE(array_agg(person_id), '{}'::text[]) AS ids FROM staff
)
UPDATE calendar_events c
SET matched_person_ids = NULLIF(
      ARRAY(
        SELECT unnest(c.matched_person_ids)
        EXCEPT
        SELECT unnest(s.ids)
      ),
      '{}'::text[]
    )
FROM staff_arr s
WHERE c.matched_person_ids && s.ids;
