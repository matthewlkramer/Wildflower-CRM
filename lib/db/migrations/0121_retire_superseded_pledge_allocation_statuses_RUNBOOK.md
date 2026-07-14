# 0120 — Retire the superseded pledge-allocation statuses (Task #665)

## What this is

The `superseded` / `superseded_by_pledge` / `superseded_by_gift` values of the
`pledge_allocation_status` enum are retired. They were nearly unused (4 rows in
prod, all on two long-closed opportunities) and added confusing options to the
allocation editor. The decision: users keep pledge allocations accurate
directly, so the superseded concept goes away.

Code side (ships via Publish, already done in this task):

- Removed from the OpenAPI contract — the generated Zod validators now reject
  the three values with a 400 on create/update.
- Removed from the allocation-editor status dropdown.
- The gift→pledge split path now writes `committed` instead of
  `superseded_by_gift` (the fully-paid pledge derives `cash_in`, so it never
  re-enters open-pipeline analytics).

Data side (this file): remap the 4 historical prod rows to `abandoned`.

## Why `abandoned` is total-neutral

- The only allocation-status-filtered money read is
  `/projections-by-fy-entity`, which requires the parent opp to be
  `status='open'` AND only includes `working` / `committed` /
  `committed_with_conditions` — it already excluded BOTH superseded and
  abandoned rows.
- Every other rollup (pledged amount, opp status/paid derivation, dashboard
  metrics) sums allocations without an allocation-status filter, and the remap
  does not touch amounts or scope.
- Both parent opps are `cash_in` / stage `complete`; re-verified after the dev
  remap that awarded, allocation sum, status, and stage are unchanged.

## The 4 prod rows (verified 2026-07-13 against the prod replica)

| id                      | old status            | opportunity                        |
|-------------------------|-----------------------|------------------------------------|
| `recPU7DLiO1By8jaw`     | `superseded_by_pledge`| Chan Zuckerberg Initiative fy16-17 |
| `recnykefgRItfM9wP`     | `superseded_by_pledge`| Chan Zuckerberg Initiative fy16-17 |
| `h17sjkVVYjdiDMMj4F8Zc` | `superseded_by_gift`  | SPP FY20                           |
| `Sm6oT5Jmuz8-bRwi4q69a` | `superseded_by_gift`  | SPP FY20                           |

The UPDATE matches by status (not id) so any unexpected straggler is caught
too; expect **UPDATE 2–4 or fewer** depending on prior runs (idempotent — a
re-run reports `UPDATE 0`).

## Apply (human, from the repo root)

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0121_retire_superseded_pledge_allocation_statuses.sql
```

The file ends with a verification SELECT — expect **0 rows**.

## Ordering

No schema change is involved (the pg enum keeps the three values — removing a
pg enum value requires a full type rebuild, deliberately out of scope), so this
can be applied before or after Publish. Apply it whenever convenient; until it
runs, the 4 rows simply keep their old (now read-only) status.

## Rollback

Non-destructive: only `status` (and `updated_at`) changed on the listed rows.
To restore, set each id back to its old status from the table above.
