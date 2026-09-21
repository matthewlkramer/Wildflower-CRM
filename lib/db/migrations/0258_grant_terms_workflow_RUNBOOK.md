# Grant terms workflow release runbook

Migration: `lib/db/migrations/0258_grant_terms_workflow.sql`

This release adds the versioned, human-reviewed grant-agreement terms model:

- `grant_term_sets`
- `grant_terms`
- `grant_term_outcome_events`
- `grant_spend_snapshots`
- supporting enums, foreign keys, checks, and indexes

The migration is additive and contains no data backfill. The application reads
the new tables when an opportunity is opened, so do not publish the new code
unless the development database contains the new schema and the Replit Publish
diff is additive-only.

## Release order

1. Merge the reviewed code to GitHub `main`.
2. In Replit, reconcile the local checkout with GitHub. Preserve legitimate
   Replit-local work and verify that the intended merge commit is present.
3. Let the post-merge database push run against the development database.
4. Verify the development database contains all four tables:

   ```sql
   SELECT table_name
   FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN (
       'grant_term_sets',
       'grant_terms',
       'grant_term_outcome_events',
       'grant_spend_snapshots'
     )
   ORDER BY table_name;
   ```

   If post-merge push aborted before applying the additive schema, a human may
   reconcile development with the checked-in migration:

   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0258_grant_terms_workflow.sql
   ```

5. Inspect the Replit Publish database diff. It must contain only the intended
   additive objects. Do not choose any option that copies development data to
   production, and stop if the diff proposes a drop, rename, type reversal, or
   nullability reversal.
6. Use Replit **Republish** and wait for the deployment health check to pass.
7. After Publish, a human may run the reviewed idempotent migration against
   production. This should be a no-op for objects Publish already created:

   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0258_grant_terms_workflow.sql
   ```

## Verification

1. Confirm `https://wfcrm.replit.app/api/healthz` is healthy.
2. Open an existing opportunity and confirm the Grant restrictions and
   conditions section loads without an error.
3. Create or edit a test opportunity with a manual restriction, then confirm it
   appears as the active term set.
4. Upload a test grant agreement and confirm the AI proposal remains pending
   until a user accepts or revises it.
5. Confirm accepting the proposal supersedes the prior active term set and that
   the opportunity's restricted and conditional summaries follow the accepted
   allocation terms.
6. Record a test condition outcome and a cumulative spend checkpoint, refresh,
   and confirm both remain visible.

## Rollback

If the application health check fails, use Replit's deployment rollback so the
previous code continues serving. Leave the additive schema in place; the prior
application does not read it, and retaining it avoids destructive rollback.
Investigate and republish a corrected release rather than dropping tables or
enums that may now contain reviewed grant data.
