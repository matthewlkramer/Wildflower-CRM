# Media relevance-filtering rollout

This rollout adds deterministic relevance scoring to media mentions. It does
not delete mentions, and historical rows remain visible until the separate
backfill is explicitly run.

## Staging

1. Apply the migration to staging:

   ```sh
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
     -f lib/db/migrations/0243_media_relevance_filtering.sql
   ```

2. Deploy the application build to staging.
3. Run the backfill manually:

   ```sh
   pnpm --filter @workspace/api-server run backfill:media-relevance
   ```

4. Review filtered and pinned results in the CRM. Confirm that tracking URL
   variants collapse to one article and that pinned rows remain visible.
5. Obtain human sign-off before repeating the migration and backfill against
   production.

## Production

Repeat the staging migration and backfill commands only after sign-off. The
backfill processes 100 rows at a time, resumes from rows whose score is null,
and never changes `is_filtered` on pinned rows.

## Verify

```sql
SELECT
  count(*) FILTER (WHERE relevance_score IS NULL) AS unscored,
  count(*) FILTER (WHERE is_filtered) AS filtered,
  count(*) FILTER (WHERE pinned AND is_filtered) AS pinned_filtered
FROM media_mentions
WHERE dismissed = false;
```

`pinned_filtered` may be nonzero because pinning does not rewrite the stored
classification; API and UI readers always surface pinned rows.
