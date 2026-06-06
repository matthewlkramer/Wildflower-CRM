# Runbook — 0031 + 0032: expensify & returned-wire exclusions

Adds two new AUTO staged-payment exclusion reasons and backfills them over the
existing QuickBooks review queue:

- **`expensify`** — Expensify expense-reimbursement activity (the `expensify`
  marker anywhere on the row). Never a gift.
- **`returned_wire`** — a wire transfer the org SENT that bounced back (the
  `returned wire` marker anywhere on the row). Not an incoming contribution.

Both rules are now applied by the classifier (`quickbooksExclusionRules.ts`) at
insert time. These two files catch up the rows already in the queue.

## Why these bypass the donation-first guard

Both are IDENTITY / TEXT rules (like `fiscally_sponsored` and `insurance`): they
identify money that is categorically not a gift regardless of how the line is
coded. In the classifier they fire right after `insurance`, BEFORE the donation
guard and every guarded line-based rule.

## Precedence (first-match-wins)

`… → fiscally_sponsored → insurance → expensify → returned_wire →
[donation guard] → loan(guaranty) → interest → tax_refund → other_revenue →
earned_income → expense_refund → membership`

The 0032 backfill mirrors this by running the `expensify` UPDATE first, then the
`returned_wire` UPDATE, both `pending`-only. (The two markers never co-occur in
practice; the order only matters for determinism.)

## Apply order

1. **0031 enum** — run WITHOUT `-1` (ADD VALUE can't run in a txn block):

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0031_quickbooks_expensify_returned_wire_enum.sql
   ```

2. **0032 backfill** — run WITH `-1` (single transaction):

   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0032_quickbooks_expensify_returned_wire_backfill.sql
   ```

Prerequisite: the new app code is deployed and existing rows carry line detail
(`line_description` / `line_account_names` / `line_item_names` / `line_classes`).

## SQL ⇄ TS equivalence

- `expensify` — TS: case-insensitive substring `expensify` over every captured
  field. SQL: `lower(concat_ws(' ', …)) LIKE '%expensify%'`.
- `returned_wire` — TS: `/returned\s+wire/i` over the joined fields. SQL:
  `lower(concat_ws(' ', …)) ~ 'returned[[:space:]]+wire'` (whitespace-tolerant;
  matches "returned wire" / "returned  wire" / "RETURNED WIRE").

## Manual review items (NOT handled by the backfill)

- The `pending`-only filter does not touch rows that were already `approved`,
  `rejected`, or `excluded` under a different reason before these reasons existed.
  If any approved row is actually an Expensify reimbursement or a returned wire,
  reject / unwind it per-row. Find candidates with:

  ```sql
  SELECT id, status, exclusion_reason, amount, payer_name, raw_reference
    FROM staged_payments
   WHERE lower(concat_ws(' ', payer_name, raw_reference, line_description))
         LIKE '%expensify%'
      OR lower(concat_ws(' ', payer_name, raw_reference, line_description))
         ~ 'returned[[:space:]]+wire';
  ```

## Verification

```sql
SELECT status, exclusion_reason, count(*)
  FROM staged_payments
 GROUP BY 1, 2
 ORDER BY 1, 2;
```

Re-running either file is a no-op (`pending`-only + idempotent enum guards).
