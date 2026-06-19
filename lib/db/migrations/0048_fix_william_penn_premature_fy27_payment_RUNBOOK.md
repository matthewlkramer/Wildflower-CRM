# Runbook — 0048: fix the William Penn premature FY27 installment

## Problem

The pledge **"FY26 William Penn grant"** (`recZRA7dsk2g2CQAp`, awarded **$478,250**)
was imported from Airtable with **both** installments already recorded as received
`pledge_payment` rows:

| gift id               | FY   | amount       | date       | cash behind it?            |
| --------------------- | ---- | ------------ | ---------- | -------------------------- |
| `recuBzTJBnXg2nNNX`   | FY26 | $223,500.00  | 2025-09-19 | yes — QuickBooks-backed    |
| `recT6GdHbEEhvI4dq`   | FY27 | $254,750.00  | 2025-09-22 | **no — not yet collected** |

FY27 starts July 2026, so the second installment has not arrived. Booking it as a
received payment overstates received revenue by $254,750 and forces the pledge to
derive as `status='cash_in'` (fully collected) when only $223,500 is actually in.

The pledge's `awarded_amount` already encodes the full $478,250 commitment, so the
correct representation is: keep the one real payment and let the pledge carry the
$254,750 as an **outstanding balance** until William Penn pays it (it will then
arrive through QuickBooks and be matched/minted normally).

This is the **only** pledge_payment in the database booked for a future fiscal year
(confirmed by a full sweep), so the fix is scoped to this single row.

## What 0048 does

0. Locks the FY27 gift row `FOR UPDATE` so no concurrent insert can add a
   child/ref between the guard check and the delete.
1. Deletes the FY27 gift's one synthetic allocation (`gift_allocations` is RESTRICT)
   — guarded by the same predicate as the gift delete.
2. Deletes the FY27 gift `recT6GdHbEEhvI4dq` — guarded so a QuickBooks-linked row,
   one with splits, or one another gift is matching against is never touched
   (it currently has zero inbound refs).
3. Re-derives the pledge's persisted `status` / `stage` / `win_probability` from the
   remaining payments, fully mirroring `deriveOppFields` (`cash_in` -> `pledge`,
   `1.0000` -> `0.9000`; stage stays `written_commitment`; advances stage to
   `cash_in` only if ever fully paid). Keyed off the live `SUM`, so it is idempotent
   and self-correcting if WP later pays the balance.

**Why delete, not archive:** `paid_amount` in `pledgeStage.ts` sums *all* linked
payments including archived rows, so archiving would not correct the derivation.

## Pre-flight (expect the two rows above)

```sql
SELECT g.id, g.amount, g.date_received, g.name
  FROM gifts_and_payments g
 WHERE g.payment_on_pledge_id = 'recZRA7dsk2g2CQAp'
 ORDER BY g.date_received;
```

## Apply

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0048_fix_william_penn_premature_fy27_payment.sql
```

Transactional; a no-op on re-run.

## Verification

```sql
-- FY27 gift gone (expect 0):
SELECT count(*) FROM gifts_and_payments WHERE id = 'recT6GdHbEEhvI4dq';

-- pledge re-derived (expect status=pledge, stage=written_commitment,
-- win_probability=0.9000, paid=223500.00, outstanding=254750.00):
SELECT o.id, o.status::text, o.stage::text, o.win_probability, o.awarded_amount,
       (SELECT COALESCE(SUM(amount),0) FROM gifts_and_payments
          WHERE payment_on_pledge_id = o.id) AS paid,
       o.awarded_amount - (SELECT COALESCE(SUM(amount),0) FROM gifts_and_payments
          WHERE payment_on_pledge_id = o.id) AS outstanding
  FROM opportunities_and_pledges o WHERE o.id = 'recZRA7dsk2g2CQAp';
```
