# 0028 — Exclude interest / investment income matched by account NAME

## What & why

The `interest` exclusion rule matched the income accounts only by QuickBooks
account-code **prefix** (`4010%` Interest Earned, `4040%` Realized Gain/Loss on
Investments). QuickBooks sometimes emits those same accounts by their human
**name** with no leading code — e.g. `Realized Gain/Loss on Investments`,
`Interest Earned`. Those rows slipped past the prefix match and stayed in the
review queue (e.g. a ~$27.8k "Wells Fargo(c)" gain/loss deposit).

- **Code:** the classifier now also matches the interest family by account-NAME
  substring (`INTEREST_ACCOUNT_NAME_SUBSTRINGS` in
  `artifacts/api-server/src/lib/quickbooksExclusionRules.ts`). New pulls are
  classified at insert time.
- **Data:** `0028_quickbooks_interest_by_name_backfill.sql` re-classifies the
  **existing** pending rows. Reuses the existing `interest` reason — no enum
  change, so there is no separate enum file for this migration.

## Safety

- Pending-only, idempotent, donation-first guarded (a bundled gift line is never
  hidden). Approved / rejected / already-excluded rows are untouched.

## Apply (production — human-run)

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0028_quickbooks_interest_by_name_backfill.sql
```

Run only after the new app code is deployed. Verify:

```sql
SELECT status, exclusion_reason, count(*)
FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;
```

The pending count should drop and the `excluded / interest` count should rise by
the number of code-less interest/investment rows.

## Note on the back-catalog

If any old rows are missing `line_account_names`, they can't be classified by
account and won't be caught — the QB sync is watermark-based and does not enrich
historical line detail. See the 0020-0021 runbook for the full re-pull procedure.
