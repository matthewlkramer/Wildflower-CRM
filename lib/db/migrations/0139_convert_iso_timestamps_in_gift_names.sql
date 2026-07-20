-- Convert ISO 8601 UTC timestamps embedded in gift names to M/D/YY date format.
-- Affects gifts_and_payments only (20 rows; opportunities_and_pledges has none).
--
-- Example transformation:
--   "McDowell 514.41 2026-02-06T21:17:17.771Z"  →  "McDowell 514.41 2/6/26"
--   "MILLER 104.7 2026-01-01T04:51:37.240Z"      →  "MILLER 104.7 1/1/26"
--
-- Date is taken from the UTC date component of the timestamp (the portion before the T).
-- Idempotent: after conversion the pattern no longer matches, so re-runs affect 0 rows.
--
-- Apply:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0139_convert_iso_timestamps_in_gift_names.sql

UPDATE gifts_and_payments
SET
  name = regexp_replace(
    name,
    '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z?',
    to_char(
      (regexp_match(name, '([0-9]{4}-[0-9]{2}-[0-9]{2})T[0-9]{2}:[0-9]{2}:[0-9]{2}'))[1]::date,
      'FMMM/FMDD/YY'
    )
  ),
  updated_at = now()
WHERE name ~ '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}';
