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
applied by a human via `psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <file>.sql`.
Verify the gap read-only first: `SELECT extname FROM pg_extension WHERE extname=...`.
Note dev can have the extension (from an earlier push) yet still be missing the
opclass GIN indexes — apply the same file to dev for parity.
