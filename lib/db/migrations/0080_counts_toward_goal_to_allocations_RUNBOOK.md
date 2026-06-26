# 0080 — Move "counts toward goal" to gift allocations

## What this changes

"Counts toward goal" is now an **allocation-level** fact on
`gift_allocations.counts_toward_goal`. The old header flag on
`gifts_and_payments` and the copy on `staged_payments` are retired, along with
the never-shipped `staged_payments.sync_gap` annotation.

The app code (analytics goal rollups, QB auto-create, manual gift/allocation
forms) already reads/writes only the allocation flag. The three old columns are
kept `@deprecated` in the Drizzle schema so Publish does not try to drop them.

## Order of operations

1. **Publish** the new code first (normal flow). This adds
   `gift_allocations.counts_toward_goal` to prod via the drizzle diff and stops
   all reads/writes of the three retired columns.
2. **Run the backfill** (idempotent, monotonic — only ever sets `false`):

   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
     -f lib/db/migrations/0080_counts_toward_goal_to_allocations.sql
   ```

   Confirm the `NOTICE` line reports **un-propagated header rows = 0**.

## Backfill semantics

- Propagates every existing "non-goal" signal down to the gift's allocations:
  - a gift **header** flagged `counts_toward_goal = false`, and
  - a **linked staged row** flagged non-goal (catches pre-0072 CSP /
    government-reimbursement gifts whose header was minted `true` but whose
    staged row 0072 later flipped to `false`). The staged→gift link is followed
    through **all five** resolution paths — the three direct columns
    (`created_gift_id` / `matched_gift_id` / `group_reconciled_gift_id`) plus
    `staged_payment_splits` and the `payment_applications` ledger (the latter two
    guarded by `to_regclass` so the file is safe where those tables don't exist
    yet).
- Monotonic + guarded on the allocation still being `true`, so on the **same
  source state** it is a no-op on re-run. It is a one-time file: do **not** re-run
  it after an admin manually flips an allocation back to `true`, or it would
  re-flip that intentional edit to `false`. Run it once, right after the column
  is added.

## Deferred cleanup (separate, later, by hand)

Only after the new code is deployed and the report shows un-propagated = 0, drop
the three retired columns (commented section 3 of the SQL) **and** remove the
matching `@deprecated` columns from the Drizzle schema in the same change so dev
and prod stay in lockstep:

```sql
ALTER TABLE gifts_and_payments DROP COLUMN IF EXISTS counts_toward_goal;
ALTER TABLE staged_payments    DROP COLUMN IF EXISTS counts_toward_goal;
ALTER TABLE staged_payments    DROP COLUMN IF EXISTS sync_gap;
```
