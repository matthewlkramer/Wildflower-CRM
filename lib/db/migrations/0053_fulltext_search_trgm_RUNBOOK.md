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

## ⚠️ Required before Publish (not just performance)

If these indexes exist in **dev** but are missing from **prod**, the Publish
schema-diff will try to add them itself and auto-generate a **broken** statement —
it emits `CREATE INDEX … USING gin ("name")` **without** the `gin_trgm_ops`
operator class — which fails with:

```
data type text has no default operator class for access method "gin"
```

Publish surfaces this generically as *"Migrations failed validation … schema
changes conflict with existing production data and could not be applied."* That
wording is misleading — it is **not** a data conflict. **Do not** choose "Copy
dev schema & data to production" (that overwrites live prod data).

**Resolution:** apply this file to **prod by hand first** (below). Once prod has
the five indexes, the dev↔prod diff no longer contains them, the broken statement
is never generated, and Publish proceeds normally (creating the rest of the diff —
new tables, FKs, plain indexes — correctly).

For search *correctness* the indexes are optional (search falls back to a
sequential scan), but for **Publish to succeed** they must be present in prod.

## Apply

Idempotent and row-data-free; safe to run any number of times, in any
environment.

Run against the **production** database (use your prod connection string), from
the `lib/db/migrations/` directory:

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0053_fulltext_search_trgm.sql
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
