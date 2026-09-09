-- Google Calendar details needed by trip-window sync. Idempotent and additive.
-- Apply from repository root:
-- psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0236_trip_window_calendar_details.sql

ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS transparency text;

ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS google_visibility text;
