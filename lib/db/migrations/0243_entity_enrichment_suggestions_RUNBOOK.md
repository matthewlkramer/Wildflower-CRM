# Entity enrichment suggestions rollout

Migration `0243_entity_enrichment_suggestions.sql` creates an additive sidecar
for suggested person and organization field values. It never changes canonical
entity data. A canonical value changes only after an authorized owner or admin
accepts a suggestion in the CRM.

## Order

1. Publish the application/schema release through Replit.
2. Apply the idempotent migration to production:

```sh
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0243_entity_enrichment_suggestions.sql
```

3. Verify the table and partial uniqueness guard:

```sql
SELECT to_regclass('public.enrichment_suggestions') AS table_name,
       to_regclass('public.enrichment_suggestions_pending_uq') AS pending_guard,
       count(*) AS suggestion_count
FROM enrichment_suggestions;
```

4. On a person or organization with an address-derived region and no confirmed
   region value, choose **Check CRM suggestions**. Confirm that accepting writes
   the canonical region and an audit entry, while dismissing leaves it unchanged.

## Rollback

Disable the UI/routes by rolling back the application release. Preserve the
table as provenance; dropping it would discard review history and is not part
of normal rollback.
