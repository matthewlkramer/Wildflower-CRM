# Feedback field migrations

These migrations add calendar sync progress tracking and a current/past state
for contact addresses. They do not delete data. The second migration also marks
Emma Pengelly's reviewed Bentonville address Past while preserving the address.

1. Publish the schema and application code to Replit. Verify that Publish's
   schema step added `calendar_sync_state.no_progress_runs` and
   `addresses.is_current` before letting the new API serve traffic. If Publish
   does not apply both columns, apply the SQL below before starting the new API.
2. From the repository root in the Replit shell, with a production database
   URL in `PROD_DATABASE_URL`, apply both idempotent files in order:

   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0270_calendar_sync_progress.sql
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0271_address_currentness.sql
   ```

3. Verify Emma's Bentonville row is present but `is_current = false`, other
   addresses remain current, and Admin → Integrations / Sync shows calendar
   retry counts after subsequent sync runs. No rows are removed. The QuickBooks
   attachment change has no schema migration, but its live verification needs
   the QuickBooks connection reauthorized if it still reports `invalid_grant`.
