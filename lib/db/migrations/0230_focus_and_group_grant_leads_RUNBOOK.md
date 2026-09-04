# 0230 Grant lead cleanup and grouping runbook

This data migration archives only the reviewed classes of obvious Grant Leads
false positives and collapses the reviewed Cummings, Camelback, and Minneapolis
re-announcements. It does not delete leads or source-email provenance.

Apply it to development before publishing so Replit's development and
production databases remain aligned, then apply the same file to production:

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0230_focus_and_group_grant_leads.sql
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0230_focus_and_group_grant_leads.sql
```

Verify both databases:

```sql
SELECT status, count(*) FROM grant_leads GROUP BY status ORDER BY status;

SELECT gl.title, gl.dedupe_key, count(gls.id) AS source_emails
FROM grant_leads gl
LEFT JOIN grant_lead_sightings gls ON gls.grant_lead_id = gl.id
WHERE gl.status IN ('new', 'claimed')
GROUP BY gl.id, gl.title, gl.dedupe_key
ORDER BY source_emails DESC, gl.title;
```

Expected result: the obvious promotions/resources/decisions are archived, and
each reviewed named program has one active row with all source emails under it.
Archived rows remain recoverable through the archived view.
