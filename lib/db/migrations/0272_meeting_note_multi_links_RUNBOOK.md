# 0272 meeting-note multi-links

This release changes meeting-note contact identity from exactly one scalar FK to arrays of linked people, organizations, and households. No existing note is duplicated or discarded. Replit is the deployment host; do not use Vercel.

1. Review the code/SQL and reconcile Replit-local changes with GitHub `main`. Apply this migration and smoke-test multi-record notes against an isolated development database first. Record production preflight counts:

   ```sql
   SELECT count(*) AS notes,
          count(*) FILTER (WHERE person_id IS NOT NULL) AS person_links,
          count(*) FILTER (WHERE organization_id IS NOT NULL) AS organization_links,
          count(*) FILTER (WHERE household_id IS NOT NULL) AS household_links
   FROM meeting_notes;
   ```

2. Apply the reviewed migration to production **before** Republish, while the old app still works through the transitional scalar allowance:

   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0272_meeting_note_multi_links.sql
   ```

3. Republish the GitHub `main` commit in Replit. Verify a meeting matching both a person and an organization saves one note with both links, then appears once on each record. Also verify an unmatched calendar meeting can save a note and a standalone note without any link is rejected.

4. Rerun the same idempotent SQL command immediately after Publish to pick up old-app meeting notes created or relinked in the migration-to-publish interval. An old-app relink of an existing note may leave its prior array link in place, so review notes changed during that interval and remove any stale associations through the new UI.

5. Verify preservation and no unbackfilled old-app writes:

   ```sql
   SELECT count(*) AS missing_backfill
   FROM meeting_notes
   WHERE (person_id IS NOT NULL AND NOT (person_id = ANY(person_ids)))
      OR (organization_id IS NOT NULL AND NOT (organization_id = ANY(organization_ids)))
      OR (household_id IS NOT NULL AND NOT (household_id = ANY(household_ids)));
   ```

   The result should be zero. Do not clear or drop the legacy columns during this release; a later reviewed cleanup can do that after the new path is verified.
