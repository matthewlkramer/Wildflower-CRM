---
name: Publish flow never creates extensions
description: Why prod can have all columns/indexes yet still fail on pg_trgm/PostGIS functions after a publish.
---

Replit's Publish flow diffs the Drizzle schema and applies **table/column/index**
changes to production automatically — including partial-unique indexes declared in
the Drizzle schema. But it **never issues `CREATE EXTENSION`**.

**Why:** any feature relying on a Postgres extension (e.g. `pg_trgm` `similarity()` /
`%`, or PostGIS) will deploy with all its columns present yet still 500 in prod with
`function <fn>(...) does not exist`. The symptom looks like "stale frontend / old
interface" but it is a missing extension. Indexes that use extension-provided opclasses
(e.g. `gin (... gin_trgm_ops)`) also can't live in the Drizzle schema, so they are
missing too.

**How to apply:** ship the extension + its opclass indexes as an idempotent SQL file
(`CREATE EXTENSION IF NOT EXISTS ...; CREATE INDEX IF NOT EXISTS ... gin_trgm_ops;`)
applied by a human via `psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/<file>.sql`
(user preference: always use `$PROD_DATABASE_URL` + full repo-root path so it runs from root).
Verify the gap read-only first: `SELECT extname FROM pg_extension WHERE extname=...`.
Note dev can have the extension (from an earlier push) yet still be missing the
opclass GIN indexes — apply the same file to dev for parity.

**Publish "conflict with existing production data" can be a LIE — it's often a
missing gin_trgm_ops index, not a data conflict.** If a `gin_trgm_ops` index
exists in dev but not prod, Publish tries to add it and auto-generates a broken
`CREATE INDEX ... USING gin ("col")` *without* the opclass → Postgres errors
`data type text has no default operator class for access method "gin"`. Publish
then shows the generic *"Migrations failed validation … schema changes conflict
with existing production data and could not be applied"* banner and offers "Copy
dev schema & data to production" (DESTRUCTIVE — never pick it). Read-only dev↔prod
introspection will look 100% clean (additive only), so don't trust the banner —
get the exact failing statement from the expandable "Failed to run database
migration" line in the Publish UI. **Fix:** apply the trigram-index SQL
(`0053_fulltext_search_trgm.sql`) to PROD by hand FIRST, then re-Publish; once prod
has the indexes the diff drops the broken statement and the rest of the diff (new
tables, FKs, plain/btree indexes — all of which Publish *can* emit correctly)
applies fine. FK adds in the same diff are safe as long as they're orphan-free in
prod (check `NOT EXISTS` against the parent before trusting them).
