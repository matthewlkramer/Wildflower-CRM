# 0053 — Trigram search indexes for the unified GET /search endpoint

## What this does

Adds the `pg_trgm` extension and five `gin_trgm_ops` GIN indexes that back the
unified **GET /search** endpoint (`routes/search.ts`). The endpoint matches each
core entity HYBRID — substring `ILIKE '%q%'` **OR** pg_trgm fuzzy `col % q`,
ranked by `similarity()` — and both the `%` operator and `similarity()` come
from the `pg_trgm` extension. The GIN indexes make both the substring scan and
the fuzzy `%` match fast.

Indexes created (all `IF NOT EXISTS`):

- `organizations_name_trgm` on `organizations(name)`
- `people_full_name_trgm` on `people(full_name)`
- `households_name_trgm` on `households(name)`
- `opportunities_and_pledges_name_trgm` on `opportunities_and_pledges(name)` **(new)**
- `gifts_and_payments_name_trgm` on `gifts_and_payments(name)` **(new)**

The first three were already created by **0023** (the QuickBooks matcher);
re-declaring them here is a harmless no-op and keeps the full search index set
documented in one place. Only the opportunities/gifts indexes are genuinely new.

## Why this is a manual psql file (not Publish / not push)

- **Publish never issues `CREATE EXTENSION`.** The schema-diff publish flow
  applies columns/indexes it can express in the Drizzle schema, but it never
  creates Postgres extensions. `pg_trgm` must be installed by hand in every
  environment (see memory `publish-flow-extensions.md`).
- **Drizzle can't express `gin_trgm_ops`.** These indexes use the trigram
  operator class, which the Drizzle schema can't represent, so `drizzle-kit
  push` will silently **drop** them (it can't see them in the schema). Re-apply
  this file after any `push`.

These indexes are **performance-only** — search is correct without them (it just
falls back to a sequential scan), so applying this file is non-urgent but
strongly recommended on any non-trivial dataset.

## Apply

Idempotent and row-data-free; safe to run any number of times, in any
environment.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0053_fulltext_search_trgm.sql
```

## Verify

```sql
SELECT indexname
FROM pg_indexes
WHERE indexname IN (
  'organizations_name_trgm',
  'people_full_name_trgm',
  'households_name_trgm',
  'opportunities_and_pledges_name_trgm',
  'gifts_and_payments_name_trgm'
)
ORDER BY indexname;
-- expect all 5 rows
```

## Non-destructive guarantee

`CREATE EXTENSION IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` only — no table,
column, or row is ever modified or dropped. Re-running is a no-op.
