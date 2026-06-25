# 0078 — Backfill historical grouping into the reconciliation workbench

**Type:** DATA-ONLY, non-destructive, idempotent. No schema or app-code change.

## Why

The legacy `/staged-payments/group-reconcile` flow tied several staged payments
to one gift (e.g. a `$65k + $15k` pair of QuickBooks deposit lines making one
`$80k` gift) by stamping `group_reconciled_gift_id` on every member — but it
never set `source_group_id`.

The new reconciliation workbench groups cards **only** by `source_group_id`, so
those historical groups are invisible as groups. Their non-representative
members (`group_reconciled_gift_id` set, `matched_gift_id`/`created_gift_id`
NULL) leak into the queue as standalone cards, and approving one compares a
single member's amount against the **full** gift → a false "amount mismatch"
that can't be resolved.

This file copies the historical grouping into `source_group_id` (a deterministic
`'histgrp_' || <gift id>`), so the workbench collapses each group into one card
whose summed total matches the gift.

## Scope (production, verified read-only at authoring time)

- **19** historical groups, **54** member rows, **0** already carry
  `source_group_id` → all 54 to be stamped.
- **35** of those are currently leaking into the queue as standalone cards.

## Pre-check (read-only)

```sql
-- Safety: there must be NO pre-existing 'histgrp_' source groups before the
-- first apply (this prefix is owned exclusively by this backfill). Expect 0:
SELECT count(*) AS preexisting_histgrp
FROM staged_payments
WHERE source_group_id LIKE 'histgrp_%';

-- How many rows WILL be updated (expect ~54):
SELECT count(*) AS will_update
FROM staged_payments sp
WHERE sp.group_reconciled_gift_id IS NOT NULL
  AND sp.source_group_id IS NULL
  AND sp.group_reconciled_gift_id IN (
    SELECT group_reconciled_gift_id FROM staged_payments
    WHERE group_reconciled_gift_id IS NOT NULL
    GROUP BY group_reconciled_gift_id HAVING COUNT(*) >= 2
  );

-- Leaking standalone cards before the fix (expect ~35):
SELECT count(*) AS leaking_before
FROM staged_payments sp
WHERE sp.status = 'approved'
  AND sp.group_reconciled_gift_id IS NOT NULL
  AND sp.matched_gift_id IS NULL
  AND sp.created_gift_id IS NULL
  AND sp.source_group_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM stripe_payouts po
    WHERE po.matched_qb_staged_payment_id = sp.id
       OR po.proposed_qb_staged_payment_id = sp.id
  );
```

## Apply (from the repo root)

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0078_backfill_historical_source_group_id.sql
```

`UPDATE 54` (or fewer if some were already grouped) is the expected output.

## Post-check (read-only)

```sql
-- Every historical group now shares one source_group_id; member count matches:
SELECT source_group_id,
       count(*)            AS members,
       sum(amount)::text   AS group_total,
       string_agg(DISTINCT status, ',') AS statuses
FROM staged_payments
WHERE source_group_id LIKE 'histgrp_%'
GROUP BY source_group_id
ORDER BY count(*) DESC;

-- No group-reconciled rows left ungrouped (expect 0):
SELECT count(*) AS still_ungrouped
FROM staged_payments sp
WHERE sp.group_reconciled_gift_id IS NOT NULL
  AND sp.source_group_id IS NULL
  AND sp.group_reconciled_gift_id IN (
    SELECT group_reconciled_gift_id FROM staged_payments
    WHERE group_reconciled_gift_id IS NOT NULL
    GROUP BY group_reconciled_gift_id HAVING COUNT(*) >= 2
  );
```

## Idempotency

Re-running the file is a safe no-op: every targeted row already has a non-NULL
`source_group_id`, so the `WHERE source_group_id IS NULL` guard matches nothing
(`UPDATE 0`).

## Rollback (only if needed)

Revert ONLY rows whose `source_group_id` still equals the exact deterministic
value this backfill wrote (so a row a human has since re-grouped is never
touched):

```sql
UPDATE staged_payments
SET source_group_id = NULL, updated_at = now()
WHERE group_reconciled_gift_id IS NOT NULL
  AND source_group_id = 'histgrp_' || group_reconciled_gift_id;
```

This is safe because the `'histgrp_'` ids are created exclusively by this
backfill (the app's own grouping uses opaque random ids), and matching the full
derived value (not just the prefix) means the rollback can never clear a
human-created or re-edited workbench group.
