# Runbook — 0096 Retire the orphaned `restriction_type` enum type

## What this does

Drops the now-unused `restriction_type` Postgres enum type. Migration 0095
physically dropped the last columns that used it
(`gift_allocations.restriction_type` and `pledge_allocations.restriction_type`),
which had already been superseded by the three-axis restriction taxonomy
(`regional/usage/time_restriction_type`, the `restriction_axis` enum). With no
column, function, or default left referencing it, this type is dead weight.

```sql
DROP TYPE IF EXISTS restriction_type;
```

### ⚠️ Do NOT touch `deferred_revenue`

The `deferred_revenue` enum is **still LIVE** — `staged_payments.deferred_revenue`
uses it. This migration is strictly the `restriction_type` type.

## Why it is safe (verified zero references, dev AND prod)

- No table column has `udt_name = 'restriction_type'` once 0095 is applied (it
  dropped the last two). Verified read-only against **both dev and prod**.
- The Drizzle schema no longer defines any column of this type. The lone remaining
  `restrictionTypeEnum` export in `lib/db/src/schema/_enums.ts` (used by no table)
  is removed by this task's code. `drizzle-kit` only manages enums attached to a
  column, so deleting that orphan export produces **no Publish diff**.
- No function, view, or default references the type.
- **No CASCADE.** A bare `DROP TYPE` (no `CASCADE`) fails loudly if any dependency
  still exists — it can never silently cascade-drop a live column. This is the
  safety net: if 0095 has NOT been applied yet, this file **errors out** instead of
  destroying data.

## Pre-checks (re-run read-only against prod right before scheduling the drop)

```sql
-- The type exists (so the drop is meaningful, not a no-op):
SELECT typname FROM pg_type WHERE typname = 'restriction_type';

-- NOTHING references it — expect ZERO rows. If any appear, 0095 has not been
-- applied yet: apply 0095 FIRST, then re-run this check.
SELECT table_name, column_name FROM information_schema.columns
WHERE udt_name = 'restriction_type';

-- deferred_revenue is untouched and still in use (expect ONE row + its column):
SELECT typname FROM pg_type WHERE typname = 'deferred_revenue';
SELECT table_name, column_name FROM information_schema.columns
WHERE udt_name = 'deferred_revenue';
```

## Deploy ordering (prod)

1. **Apply 0095 FIRST** (`0095_drop_deprecated_allocation_cols.sql`). It drops the
   last columns that use this enum. This file (`DROP TYPE`, no `CASCADE`) will
   **error** if 0095 has not run, so ordering is self-enforcing.
2. **Publish ordering is a non-issue here.** Unlike 0094/0095, the deployed prod
   build does not reference the `restriction_type` *type* at all — the columns were
   already removed from the Drizzle schema in the 0095 task; this task only deletes
   an unused enum export. Publish diffs **dev-DB vs prod-DB**, and both hold the
   identical orphaned type, so the diff is clean and proposes nothing.
3. Apply this file to **prod**:
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0096_drop_restriction_type_enum.sql
   ```
4. Apply the SAME file to **dev**:
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0096_drop_restriction_type_enum.sql
   ```

`psql -1` wraps the file in ONE transaction — do not add `BEGIN`/`COMMIT` inside it.

## Idempotency

`DROP TYPE IF EXISTS` → safe to re-run; a second run is a no-op.

## Verify (read-only, after applying)

```sql
-- restriction_type type gone (expect ZERO rows):
SELECT typname FROM pg_type WHERE typname = 'restriction_type';

-- deferred_revenue type UNTOUCHED (expect ONE row):
SELECT typname FROM pg_type WHERE typname = 'deferred_revenue';
```

## Rollback

Structure-only if ever needed:

```sql
CREATE TYPE restriction_type AS ENUM
  ('unrestricted','purpose','time','both','unclear','na');
```

There is nothing to restore into it — the authoritative restriction signal lives on
the three-axis `restriction_axis` columns.
