-- Migration 0044: enforce globally-unique email addresses (case-insensitive)
--
-- RULE: an email address must never be attached to more than one `emails` row
-- anywhere in the CRM (person, organization, payment intermediary, household).
-- This file (a) de-duplicates any existing case-insensitive duplicate addresses,
-- then (b) adds a UNIQUE index on lower(email) so the database enforces the rule
-- going forward. lower(email) matches the normalization every read path uses.
--
-- DE-DUP RULE: within each lower(email) group, keep the row flagged
-- is_preferred (tie-break: earliest created_at, then id) and delete the rest.
-- The only foreign key to emails.id is email_proposals.target_email_id; any such
-- reference on a row about to be deleted is first re-pointed to the kept row.
--
-- IDEMPOTENT: after the first apply no duplicates remain, so the dedupe selects
-- nothing and the index uses IF NOT EXISTS. Re-running is a safe no-op.
-- NON-DESTRUCTIVE beyond the intended dedupe: only surplus copies of an address
-- that already exists on the same/another owner are removed.
--
-- ORDER OF OPERATIONS (production): run THIS FILE FIRST, then Publish. The
-- Drizzle schema declares the same index (name: emails_email_lower_unique);
-- creating it here first (IF NOT EXISTS) keeps Publish's schema diff a no-op and
-- prevents Publish from failing on pre-existing duplicates.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0044_emails_unique_email.sql

BEGIN;

-- 1. Identify the duplicate ("loser") rows and the keeper for each address.
CREATE TEMP TABLE _email_dupe_losers ON COMMIT DROP AS
SELECT id AS loser_id, keep_id
FROM (
  SELECT
    id,
    row_number() OVER w AS rn,
    first_value(id) OVER w AS keep_id
  FROM emails
  WINDOW w AS (
    PARTITION BY lower(email)
    ORDER BY is_preferred DESC, created_at ASC, id ASC
  )
) ranked
WHERE rn > 1;

-- 2. Re-point the only FK to emails.id off the rows we are about to delete.
UPDATE email_proposals ep
   SET target_email_id = l.keep_id
  FROM _email_dupe_losers l
 WHERE ep.target_email_id = l.loser_id;

-- 3. Remove the duplicate rows.
DELETE FROM emails e
 USING _email_dupe_losers l
 WHERE e.id = l.loser_id;

-- 4. Enforce the rule going forward.
CREATE UNIQUE INDEX IF NOT EXISTS emails_email_lower_unique
  ON emails (lower(email));

COMMIT;
