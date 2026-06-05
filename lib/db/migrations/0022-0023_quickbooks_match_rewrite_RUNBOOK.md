# Runbook — QuickBooks match rewrite: enable pg_trgm in production

## Symptom this fixes

After publishing the QuickBooks matching/reconciliation rewrite, **"Sync now"** and
**"Re-run match"** both fail in production (HTTP 502). The deployment logs show:

```
function similarity(text, unknown) does not exist
  at matchIntermediary (quickbooksMatch.ts)
```

This is **not** a stale frontend / "old interface." The new scored matcher uses
PostgreSQL trigram functions (`similarity()` and the `%` operator) for fuzzy
donor-name matching. Those come from the `pg_trgm` extension.

## Root cause

Replit's Publish flow diffs the Drizzle schema and applies **table/column/index**
changes to production — and it already did: every new `staged_payments` column
(`matched_gift_id`, `match_score`, `match_method`, `qb_line_id`,
`classification_source`, …) and both partial-unique indexes are present in prod.

But the Publish flow **never issues `CREATE EXTENSION`**, and the trigram GIN
indexes use `gin_trgm_ops` (which can't exist without the extension, so they are
not declared in the Drizzle schema). Those two things must be applied by hand.

Confirmed against the prod replica (read-only):

- `pg_trgm` extension — **missing**
- trigram GIN indexes (`*_name_trgm`) — **missing**
- all rewrite columns + partial-unique gift indexes — **present** (via Publish)

## Skip 0022

`0022_staged_payment_gift_was_linked.sql` adds a `gift_was_linked` column that the
rewrite then **dropped**. Prod (last applied: 0021) never ran 0022, and the
current schema does not want that column (confirmed absent in prod). **Do not run
0022** — it is superseded by the rewrite. Apply only 0023.

## What 0023 does (idempotent)

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- trigram GIN indexes on every fuzzy-matched name column:
--   organizations(name), people(full_name), households(name),
--   payment_intermediaries(name)
```

Every statement is `IF NOT EXISTS`, so re-running is safe. It touches no row data
and does not change `quickbooks_connections`, so **no QuickBooks reconnect is
required**.

## Apply (production)

The agent cannot write to prod; a human applies this.

```bash
cd lib/db/migrations
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0023_quickbooks_match_rewrite.sql
```

`CREATE INDEX` (non-`CONCURRENTLY`) takes a brief lock on each table while it
builds. The tables are small enough that this is a sub-second operation; the `-1`
wraps it in a single transaction so a failure rolls back cleanly.

## Verify

```sql
SELECT extname FROM pg_extension WHERE extname = 'pg_trgm';            -- 1 row
SELECT indexname FROM pg_indexes WHERE indexname LIKE '%_name_trgm'
  ORDER BY 1;  -- households_, organizations_, payment_intermediaries_, people_
```

Then in the app: Settings → QuickBooks → **Sync now**, and the staged-payments
**Re-run match** — both should now return 200.

## Dev note

Dev already had the `pg_trgm` extension but was missing the trigram GIN indexes
(the matcher worked there only via sequential scans). The full set of indexes
above was applied to dev with the same idempotent SQL, so dev and prod now match.
