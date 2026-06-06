# Runbook — 0031: unwind 2 auto-matched expense refunds

Two QuickBooks "refund" rows predate the `expense_refund` rule (0029/0030) and
were **auto-matched** into a pre-existing gift before that rule existed. They sit
in the **Auto-matched** review bucket (`status='approved'`, `auto_applied=true`,
`match_confirmed_at` NULL), so neither the 0030 pending-only backfill nor the
in-app reclassify can reach them. They are genuine expense refunds, not gifts.

| staged id               | payer            | amount       | date       | QB account                       |
| ----------------------- | ---------------- | ------------ | ---------- | -------------------------------- |
| `sFmer7GdbGoYnQ2nnbsPB` | NCMPS            | $199,960.00  | 2021-02-12 | 702 Grants to Schools (expense)  |
| `KdOhRXgL4YGILOmjQdp5y` | Jennifer Houghton| $41.86       | 2025-11-26 | 7011 Office Supplies & Materials |

## What 0031 does

Un-reconciles both rows (clears `matched_gift_id`, resets `auto_applied`) and
marks them `excluded` / `expense_refund` with `classification_source='manual'`
so the reclassifier never flips them back.

Both rows are linked via **`matched_gift_id`** (a pre-existing gift), NOT
`created_gift_id`, so clearing the pointer is safe — the gift rows are **not**
touched and cannot be orphaned (unlinking is only allowed for `matchedGiftId`).

## Apply

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0031_quickbooks_unwind_approved_refunds.sql
```

Guarded + idempotent: only touches rows still in the auto-matched state; a no-op
on re-run (the rows are `excluded` after the first apply). If a human has already
confirmed/changed either row, the guard skips it.

## ⚠️ Gifts to review (possible washes) — NOT handled by this migration

In both cases the refund amount equals a **same-day gift from the same donor**,
which usually means the matched "gift" is the **original deposit that was later
refunded** (a wash). 0031 deliberately leaves these gifts untouched — decide
per-gift whether to void/zero them. There is no gift-level review flag, so review
them directly:

```sql
SELECT g.id, g.amount, g.date_received,
       g.organization_id, g.individual_giver_person_id, g.household_id,
       o.name AS org_name,
       concat_ws(' ', p.first_name, p.last_name) AS person_name
  FROM gifts_and_payments g
  LEFT JOIN organizations o ON o.id = g.organization_id
  LEFT JOIN people        p ON p.id = g.individual_giver_person_id
 WHERE g.id IN (
         'jmxA4QUFFdj0KFRndO1X-',  -- matched by NCMPS refund ($199,960, 2021-02-12)
         'ML4i61BCVKYCpf7jkqFbe'   -- matched by JH refund ($41.86, 2025-11-26)
       );
```

- `jmxA4QUFFdj0KFRndO1X-` — $199,960 NCMPS gift, 2021-02-12. If this gift is the
  wire that the $199,960 refund reversed, it is a wash and should be voided.
- `ML4i61BCVKYCpf7jkqFbe` — $41.86 Jennifer Houghton gift, 2025-11-26. Almost
  certainly not a real contribution (employee card reimbursement); likely void.

## Verification

```sql
SELECT id, status, exclusion_reason, classification_source,
       matched_gift_id, auto_applied
  FROM staged_payments
 WHERE id IN ('sFmer7GdbGoYnQ2nnbsPB', 'KdOhRXgL4YGILOmjQdp5y');
-- expect: both excluded / expense_refund / manual, matched_gift_id NULL, auto_applied false
```
