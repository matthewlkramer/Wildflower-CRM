---
name: Publish diffs the dev DATABASE, not the schema source
description: Why a stale dev DB silently breaks Publish (destructive prod diff, skipped additive creates, 500 healthcheck) and how to make the diff additive-only before re-publishing.
---

# Publish diffs the dev DATABASE, not the schema source

Replit's Publish computes its production schema change by **introspecting the dev
DATABASE and the prod DATABASE and diffing them** — it does NOT read the Drizzle
schema source. So the dev DB is the de-facto source of truth at publish time.

## The failure mode

If the dev DB has drifted **behind** the schema source (because post-merge
`db push` aborted/errored and never moved it forward), Publish will try to make
prod match the *stale dev DB*:

- a column the dev DB still has as the old type (e.g. `conditions_met` boolean
  vs enum) → Publish proposes a **type reversal** on prod (destructive).
- columns the dev DB is **missing** but prod has (because prod was hand-migrated
  with an idempotent SQL file that dev never received) → Publish proposes to
  **DROP** them from prod (destructive).

Those destructive statements abort the diff and the **additive** parts (new
tables / new columns) get skipped. The new code deploys, hits a missing relation,
the `/api` healthcheck returns 500, and Replit rolls back to the previous version
— so "Publish didn't work" while prod keeps serving the OLD build.

**Why:** post-merge pushes in this repo abort on the boolean→enum
`conditions_met` conversion (drizzle can't synthesize the `USING` cast — shows up
as a `cookDefault`/`heap.c` Postgres error in the merge logs) and on any live
column the schema "dropped" (retained-as-`@deprecated` pattern). The dev DB ends
up silently behind both the schema source and the hand-migrated prod DB.

## How to apply (diagnosing a failed Publish)

1. Confirm prod is actually up on the OLD build: recent deployment logs show 200s;
   the healthcheck 500s are timestamped at the failed-publish moment, not now.
2. Diff **dev DB vs prod DB** via `information_schema.columns` (run `executeSql`
   per environment, diff in the code sandbox) on BOTH column *presence* AND
   *(udt_name, is_nullable)*. The publish only succeeds when the diff is
   **purely additive** (dev-only tables/cols to create; nothing prod-only,
   no type/nullability mismatch).
3. If prod has anything dev lacks, or a type differs, **reconcile the dev DB
   FORWARD** — apply the same idempotent migration files to dev
   (`psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/<file>`),
   the same files that were hand-applied to prod. This makes dev match the schema
   source + prod.
4. Re-verify the diff is additive-only, then tell the user to **re-publish**.
   A clean additive diff lets Publish create the new tables itself — do NOT
   hand-apply the new *schema* to prod for this (only the pending *data* seeds +
   backfills run by hand afterward).
