---
name: Data-only migration must run after Publish
description: Why a prod seed/backfill SQL file fails with "relation does not exist" unless Publish ran first, and the psql -1 / BEGIN double-transaction warning.
---

A prod DATA-only migration (a seed/backfill `.sql` handed to a human to apply) must
be applied **after** a Publish, not before.

**Why:** this repo splits responsibilities — schema (new tables/columns/enums) ships
to prod via the **Publish** flow (the drizzle schema diff), while DATA ships as a
reviewed idempotent SQL file. The SQL file only INSERTs/UPDATEs; it does not create
the schema. If you run it before Publish, the tables/enums don't exist yet and it
dies with `relation "..." does not exist`. Easy to miss when the user "hasn't
published in a while" — the pending diff is large and prod is far behind dev.

**How to apply:**
1. Publish first (creates the new tables/columns/enums in prod).
2. Then: `psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <file>.sql`.

**`-1` vs BEGIN/COMMIT:** the documented runbook applies with `psql -1`, which already
wraps the whole file in one transaction. Do NOT also put `BEGIN;`/`COMMIT;` inside a
file applied that way — psql prints a harmless `WARNING: there is already a
transaction in progress` and the redundant BEGIN can confuse the operator. Pick one:
rely on `-1` (no in-file transaction) per the repo convention.
