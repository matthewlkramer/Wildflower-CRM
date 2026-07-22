---
name: Dedicated vitest test database
description: api-server vitest provisions and targets <devdb>_test; how provisioning avoids drizzle-kit's silent no-op prompt, what gets mirrored, and the failure modes.
---

# api-server vitest runs on a dedicated test DB

Every api-server vitest run provisions `<devdb>_test` (e.g. `heliumdb_test`) via
`artifacts/api-server/src/test/global-setup.ts` and repoints
`process.env.DATABASE_URL` before workers fork. Tests never touch the dev DB.

**Why:** running the suite on the live dev DB raced the dev server's schedulers
and real data — e.g. a donor-rematch test scanning donor-less staged rows lost
its rows among thousands of real ones, and 5s timeouts fired under contention.
Isolation + 6-fork parallelism took the full suite 384s → ~100s with 0 flakes.

**How to apply / key rules:**

- **drizzle-kit push --force is NOT non-interactive** when the target DB has a
  table it doesn't recognize: it prompts "create or rename?", and without a TTY
  it exits 0 having applied NOTHING. Provisioning therefore (a) keeps its stamp
  in a separate `test_meta` schema drizzle never introspects, and (b) on schema
  change drops + recreates `public` and pushes into the EMPTY schema (pure
  CREATE, no prompt). A post-push sanity check refuses to stamp if `<10` tables
  were created.
- Schema re-push is gated on a content hash of `lib/db/src/schema/*.ts`; the
  warm path costs ~1s. Force re-provision by deleting the row in
  `test_meta.schema_stamp` (or dropping the test DB).
- `pg_trgm` must be created in the test DB before push (drizzle creates trgm
  indexes but never extensions).
- Warm path TRUNCATEs all non-reference tables (clean slate each run; killed
  runs can't accumulate the 2099-band/dupspec-phone crowding leftovers), then
  re-mirrors reference tables `entities`, `regions`, `fiscal_years` from dev —
  tests key FKs to real ids (`wildflower_foundation`, `embracing_equity`).
  NOTE: TRUNCATE ... CASCADE can cascade INTO a reference table via an FK
  (observed: fiscal_years emptied); the every-setup mirror heals it. A new
  test relying on other pre-existing dev rows will fail on the test DB:
  either seed the rows in the test or add the table to `REFERENCE_TABLES`.
- A pg advisory lock (key 727501, taken on the DEV connection) is held for
  the ENTIRE run (released in globalSetup's returned teardown; session death
  releases it too). Setup-only locking was NOT enough: two concurrent suites
  sharing the DB crowded each other's date-proximity LIMIT'd searches
  (reconciliation-search-split flake). Concurrent checks now serialize —
  slower in a storm, but correct.
- If `DATABASE_URL` already ends in `_test`, setup is a no-op (re-entrancy).
- Integration project timeouts are 30s (vitest default 5s falsely fails under
  6-way DB-bound parallelism).
- Browser e2e still goes through the dev server → dev DB; dev-DB hygiene rules
  (test-data-hygiene.md) still apply to e2e, not to vitest anymore.

## No DDL in parallel test files

A test that runs `ALTER TABLE` mid-suite (e.g. dropping/re-adding a CHECK
constraint to seed an invalid row) takes an AccessExclusiveLock; while that
lock WAITS, every later reader of the table queues behind it, causing
random-victim deadlocks/failures in unrelated test files. If DDL is
unavoidable, wrap drop→insert→re-add in ONE transaction with
`SET LOCAL lock_timeout = '500ms'` and retry on 55P03/40P01 so the ALTER
fails fast instead of camping in the lock queue (see
quickbooks-group-reconcile.integration.test.ts seedNoDonorGift).
