# Runbook — 0141 Drop the three retired staged/gift-header columns deferred by migration 0080

## What this does

Physically drops three columns that were deprecated in migration 0080 (moved to
`gift_allocations`), but whose physical DROP was intentionally deferred:

| Dropped | Superseded by |
| --- | --- |
| `gifts_and_payments.counts_toward_goal` | `gift_allocations.counts_toward_goal` — goal-counting is allocation-level (backfilled by 0080) |
| `staged_payments.counts_toward_goal` | `gift_allocations.counts_toward_goal` — same signal on the staged side, retired alongside the gift header copy |
| `staged_payments.sync_gap` | Removed — the annotation was added in 0074 but never shipped to any UI or API (retired in 0080) |

None of these columns has an index or FK that requires a separate statement — all
three are plain booleans on their respective tables. The `DROP COLUMN IF EXISTS`
auto-removes any implicit dependencies.

## Why it is safe

All application code stopped reading and writing these columns when migration 0080
moved the goal-counting signal down to `gift_allocations`. Specifically:

- **`gifts_and_payments.counts_toward_goal`**: `analytics.ts` filters on
  `giftAllocations.countsTowardGoal` (the allocation column); QB/Stripe auto-mint
  paths seed `giftAllocationSeed.ts` with `countsTowardGoal`; no path writes the
  header column. Verified: no TypeScript references to `giftsAndPayments.countsTowardGoal`.
- **`staged_payments.counts_toward_goal`**: same — all downstream reads use the
  allocation-level flag. Verified: no TypeScript references to `stagedPayments.countsTowardGoal`.
- **`staged_payments.sync_gap`**: was added in migration 0074 and deprecated in 0080
  before any UI or API ever shipped it. No code references it.
- Both Drizzle schema files (`giftsAndPayments.ts`, `stagedPayments.ts`) no longer
  declare these columns, so `select()` / `getTableColumns()` on either table does
  not emit them.

## Deploy ordering — apply to prod directly (no Publish step needed)

The application code has not read or written these columns since migration 0080 ran,
which predates this task by many prior deploys. The dev DB is already clean (columns
absent). No Publish step is required before applying this file.

1. **Apply to prod:**
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0141_drop_counts_toward_goal_sync_gap.sql
   ```

2. The dev DB is already clean; running against dev is a harmless no-op thanks to
   `IF EXISTS`. If you want to keep the dev run for completeness:
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0141_drop_counts_toward_goal_sync_gap.sql
   ```

`psql -1` wraps the file in ONE transaction — do not add `BEGIN`/`COMMIT` inside it.

### Relationship to migration 0105

Migration 0105 (`0105_drop_gift_grant_year_needs_research.sql`) drops the OTHER two
columns retired from `gifts_and_payments` (namely `grant_year` and `needs_research`).
Apply **0105** and **0141** independently; they touch different columns and neither
depends on the other's ordering.

## Idempotency

`DROP COLUMN IF EXISTS` → safe to re-run; a second run on a clean DB is a no-op.

## Verify (read-only, after applying)

```sql
-- All three columns gone (expect ZERO rows):
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_name IN ('gifts_and_payments', 'staged_payments')
  AND column_name IN ('counts_toward_goal', 'sync_gap')
ORDER BY table_name, column_name;

-- counts_toward_goal still lives on the allocations (expect a healthy non-zero count):
SELECT count(*) FROM gift_allocations WHERE counts_toward_goal = true;
```

## Rollback

Structure-only if ever needed: re-add the columns from their pre-drop DDL:
- `gifts_and_payments.counts_toward_goal boolean NOT NULL DEFAULT true`
- `staged_payments.counts_toward_goal boolean NOT NULL DEFAULT true`
- `staged_payments.sync_gap boolean NOT NULL DEFAULT false`

There is nothing to restore into them — the goal-counting signal lives on
`gift_allocations.counts_toward_goal` and `sync_gap` was never populated with
meaningful data.
