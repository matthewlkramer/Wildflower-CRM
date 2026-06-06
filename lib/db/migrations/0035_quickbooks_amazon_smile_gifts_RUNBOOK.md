# Runbook — 0035: convert Amazon Smile payments into gifts

One-time catch-up that turns the Amazon Smile payments sitting in the QuickBooks
review queue into real gifts, attributed to the existing donor organization
**"Amazon / Amazon Foundation"** (`recbYyqxpJWo5bKRB`).

Amazon Smile is Amazon's charitable-giving program — small, periodic
unrestricted donations remitted by Amazon. Every such row is a genuine gift.

## What it does

For each Amazon Smile staged payment with no gift yet, it:

1. Mints a `gifts_and_payments` HEADER (no allocations — a fundraiser allocates
   afterward, same as an app-minted gift), donor = the Amazon org (Donor XOR).
2. Links the staged row to that gift and marks it `approved`
   (`auto_applied = true`, so it stays **revertible** from the UI), clearing any
   stale `exclusion_reason`.

It mirrors the app's own auto-mint path (`quickbooksSync.ts` MINT branch +
`buildGiftValuesFromStaged`). The only deliberate deviation: the gift name is the
literal `Amazon Smile` (a few rows have a blank payer and would otherwise be
named after their bank-memo line).

It does **not** add an ongoing rule — future Amazon Smile payments still land in
the queue until the separate "auto-convert going forward" task ships.

## Scope (verified against production at authoring time)

| status                    | rows | total    |
| ------------------------- | ---- | -------- |
| pending                   | 13   | $192.53  |
| excluded (other_revenue)¹ | 1    | $23.47   |

¹ One historical Amazon Smile donation was miscoded to "4030 Other Revenue" and
auto-excluded; it is re-claimed as a gift here.

## Apply

Single transaction:

```bash
cd lib/db/migrations
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0035_quickbooks_amazon_smile_gifts_backfill.sql
```

No enum / schema prerequisite — it only inserts/updates data. It intentionally
does **not** reference the deposit-grouping columns (`group_reconciled_gift_id`,
`qb_deposit_id`), so it runs whether or not the deposit-grouping schema (0034)
has been published to prod yet.

## Idempotency

- Gift id is deterministic (`'qbas_' || staged_payment.id`); the INSERT is
  `ON CONFLICT (id) DO NOTHING`.
- Only rows with no existing gift link (`created_gift_id IS NULL AND
  matched_gift_id IS NULL`) are touched.

Re-running is a no-op.

## Verification

```sql
-- 14 minted gifts, all linked to approved staged rows:
SELECT count(*) AS amazon_smile_gifts
  FROM staged_payments
 WHERE created_gift_id LIKE 'qbas_%' AND status = 'approved';

-- queue breakdown (the 13 pending Amazon Smile rows are gone; the 1
-- other_revenue exclusion has dropped by one):
SELECT status, exclusion_reason, count(*)
  FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;
```

## Rollback

Each converted row is an ordinary auto-mint, so the cleanest undo is per-row from
the QuickBooks Review UI (**Revert** deletes the minted gift and returns the row
to the queue). To unwind the whole batch in SQL (only if none have since been
allocated/edited):

```sql
BEGIN;
-- Scope strictly to THIS migration's rows: a staged row still auto-linked to a
-- 'qbas_'-prefixed gift that we minted (name 'Amazon Smile', Amazon org).
WITH mine AS (
  SELECT s.id AS staged_id, s.created_gift_id AS gift_id
    FROM staged_payments s
    JOIN gifts_and_payments g ON g.id = s.created_gift_id
   WHERE s.created_gift_id LIKE 'qbas_%'
     AND s.auto_applied = true
     AND g.name = 'Amazon Smile'
     AND g.organization_id = 'recbYyqxpJWo5bKRB'
)
UPDATE staged_payments s
   SET status = 'pending', match_status = 'unmatched',
       created_gift_id = NULL, auto_applied = false,
       organization_id = NULL, updated_at = now()
  FROM mine WHERE s.id = mine.staged_id;

DELETE FROM gifts_and_payments g
 WHERE g.id LIKE 'qbas_%'
   AND g.name = 'Amazon Smile'
   AND g.organization_id = 'recbYyqxpJWo5bKRB'
   AND NOT EXISTS (SELECT 1 FROM staged_payments s WHERE s.created_gift_id = g.id);
COMMIT;
```

> The `DELETE` only removes a minted gift once its staged row no longer points
> at it (the `UPDATE` above clears the link first), so it can never orphan a
> still-linked row.

> The re-claimed `other_revenue` row returns to `pending` (not back to
> `excluded`) on rollback — re-exclude it by hand if desired.
