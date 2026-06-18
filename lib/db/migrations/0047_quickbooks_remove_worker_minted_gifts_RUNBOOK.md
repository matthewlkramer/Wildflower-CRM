# 0047 — Remove worker-minted QuickBooks gifts (keep Amazon Smile)

## Why

The QuickBooks sync worker's auto-apply step used to **mint a brand-new gift**
whenever a high-confidence donor match had no existing gift to reconcile to. A
full re-pull ran that branch across the whole QuickBooks back catalogue and
auto-created **153 gifts with no human review — $10,273,112.72 total**, including
large foundation grants (Spring Point $1M, Walton, Valhalla $500k, Gates, Sep
Kamvar, …) and many duplicates of gifts already in the CRM.

Desired behaviour:

- **Amazon Smile** micro-deposits *should* keep auto-creating gifts without
  review (real QBO gifts never logged in the CRM). These are now handled by the
  `seed_amazonsmile` handling rule (`auto_create_approve` → GenOps), which runs
  at ingest **before** the matcher — so they are unaffected by the code fix.
- **Everything else** that the worker would have auto-created must instead land
  in the **needs-review queue** for a human to approve.

This migration is the **data cleanup** half. The **code** half (in
`artifacts/api-server/src/lib/quickbooksSync.ts`) removes the worker's generic
mint branch so it can never recur.

## What it does

1. Selects the worker mints to remove: `details LIKE 'Imported from QuickBooks (%'`
   `AND owner_user_id IS NULL AND legacy_gift_id IS NULL AND created_at_from_airtable IS NULL`
   `AND name !~* 'amazon\s*smil'` → **139 gifts** (the 14 Amazon Smile mints are
   excluded and KEPT).
2. **Preflight guard** — aborts unless the remove set is exactly **139** (or **0**
   on an idempotent re-run).
3. **Safety guard** — aborts if any `staged_payment_splits` row references the
   remove set (expected **0**).
4. **Requeues ~89 staged payments** (87 via `matched_gift_id`, 3 via
   `group_reconciled_gift_id`, 0 via `created_gift_id`) back to `pending`,
   mirroring the app's per-row revert. The donor hint is retained.
5. **Clears 1 `gift_allocations`** row (Valhalla $500k) — RESTRICT FK blocker.
6. **Deletes the 139 gifts.**

Everything runs in a single `BEGIN … COMMIT`.

## Preconditions

- Apply the **code change first via Publish** (or in the same release). If the SQL
  runs while the old worker code is still live, the next sync will re-mint these
  gifts. The preflight guard protects against running against a drifted set.
- Take/confirm a recent DB checkpoint/backup before applying (there is no
  automated rollback — see below).

## Apply

```bash
# Dev (agent): already applied if dev held the rows.
# Production (human only — the agent cannot write to prod):
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0047_quickbooks_remove_worker_minted_gifts.sql
```

Expected `NOTICE` output:

```
NOTICE:  Worker-mint cleanup: 139 gift(s) to remove.
NOTICE:  Requeued 89 staged payment(s) to needs-review (expected ~89).
NOTICE:  Cleared 1 gift_allocation(s) on the remove set (expected 1).
NOTICE:  Deleted 139 worker-minted gift(s) (expected 139).
```

(The requeue count can vary slightly if a re-pull changed staged links since
authoring; the gift count of 139 is the hard guard.)

## Verify

```sql
-- Worker mints remaining should be ONLY the 14 kept Amazon Smile gifts:
SELECT count(*) AS worker_mints_remaining,
       count(*) FILTER (WHERE name ~* 'amazon\s*smil') AS amazon_kept
  FROM gifts_and_payments
 WHERE details LIKE 'Imported from QuickBooks (%'
   AND owner_user_id IS NULL AND legacy_gift_id IS NULL
   AND created_at_from_airtable IS NULL;     -- expect 14 / 14
```

The requeued payments now appear in **QuickBooks Review** (`/staged-payments`)
for a fundraiser to approve or match.

## Idempotency

Re-running after success finds 0 remove-set gifts → every statement is a no-op
and the preflight guard passes on `n = 0`.

## Rollback

There is no automated down-migration (it deletes ledger rows). To undo, restore
from the pre-apply checkpoint/backup. Because the cleanup is wrapped in a single
transaction, a mid-run failure rolls back automatically — nothing is partially
applied.
