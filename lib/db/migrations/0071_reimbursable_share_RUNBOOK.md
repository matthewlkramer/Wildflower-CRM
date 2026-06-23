# 0071 — Reimbursable direct/indirect share tag

## What this does

Adds the nullable `reimbursable_share` (`direct` | `indirect`) tag to pledge and
gift allocation lines so the team can track the direct vs indirect share on a
reimbursable grant.

- **Full amounts are always recorded.** This is just a per-line tag.
- **Goal analytics EXCLUDE direct-tagged lines** (received, committed both sides,
  open ask, weighted ask) via `reimbursable_share IS DISTINCT FROM 'direct'`
  (null-safe). Untagged (NULL) and `indirect` both still count.
- **Never changes** opportunity-status derivation or pledge paid-amount
  derivation — those always see the full amount.

## Schema changes (additive, non-destructive)

1. `CREATE TYPE reimbursable_share AS ENUM ('direct', 'indirect')`
2. `pledge_allocations.reimbursable_share` — NULLABLE, no default
3. `gift_allocations.reimbursable_share` — NULLABLE, no default

Every existing row stays `NULL` (untagged ⇒ still counts toward goals), so there
is no data backfill and nothing to reconcile.

## Apply

The file is idempotent (enum guard + `ADD COLUMN IF NOT EXISTS`), so re-running is
a no-op.

```bash
# dev
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0071_reimbursable_share.sql

# prod (run AFTER Publish ships the code; the file only touches additive schema)
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0071_reimbursable_share.sql
```

## Verify

```sql
SELECT unnest(enum_range(NULL::reimbursable_share));   -- direct, indirect

SELECT table_name, column_name, udt_name, is_nullable, column_default
  FROM information_schema.columns
 WHERE column_name = 'reimbursable_share'
 ORDER BY table_name;
-- 2 rows (gift_allocations, pledge_allocations), udt_name reimbursable_share,
-- is_nullable YES, column_default NULL.
```

## Ordering

Ship the code via the normal Publish flow, then apply this file to prod. Because
the columns are additive and nullable, applying before or after the code deploy is
safe either way — but applying it ensures the new analytics queries that reference
`reimbursable_share` never hit a missing column.
