# 0128 — Backfill NULL `win_probability` (runbook)

## What / why

The weighted-pipeline analytics (dashboard projection tile, projections page,
FY report) no longer paper over a NULL `win_probability` with COALESCE
fallbacks (open rows used to silently count at 100%, pledged rows at 90%).
Every `opportunities_and_pledges` row must now carry a weight; the application
derivation stamps and self-heals it going forward. This migration backfills the
canonical weight onto existing rows where it is NULL, using the same rules as
the app (`canonicalWinProbability`): loss 0, fully-paid 1, written pledge
0.90/0.75-conditional, open by stage weight, unstaged open 0.

## Ordering

Run **after** Publish (the code ships the self-heal + removes the analytics
fallbacks). Safe in either order — the new code heals rows on next touch — but
until this runs, any remaining NULL rows drop out of the weighted sums, so run
it promptly.

## Apply (from the project root)

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0128_backfill_null_win_probability.sql
```

## Verify

```bash
psql "$PROD_DATABASE_URL" -c "SELECT count(*) FROM opportunities_and_pledges WHERE win_probability IS NULL;"
```

Expect `0`. The UPDATE's reported row count on first apply equals the number of
previously-NULL rows (dev had 37). Re-running is a no-op (`UPDATE 0`).

## Rollback

Not needed — the change only fills NULLs with the value the application
derivation would stamp anyway; there is no schema change.
