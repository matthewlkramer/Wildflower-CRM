# Runbook — 0029 + 0030: insurance (BASICCOBRA) & expense refunds

Adds two new AUTO staged-payment exclusion reasons and backfills them over the
existing QuickBooks review queue:

- **`insurance`** — COBRA / insurance-premium reimbursements administered by
  BASIC (the `BASICCOBRA` marker on the line). Never a gift.
- **`expense_refund`** — refunds of the org's OWN expenses (vendor overpayments,
  registration / training refunds, ERC tax refunds, etc.): money coming back,
  not a contribution.

Both rules are now applied by the classifier (`quickbooksExclusionRules.ts`) at
insert time. These two files catch up the rows already in the queue.

## Why these bypass the donation-first guard

Both are IDENTITY / TEXT rules (like `fiscally_sponsored`): they identify money
that is categorically not a gift regardless of how the line is coded.

This is not academic for `expense_refund`: the two largest pending "refund" rows
are **ERC tax refunds (~$269,782 and ~$247,708) MISCODED to a `4000.4`
donation income account**. A guarded rule would leave them in the queue forever.
They are refunds, not gifts, so the unguarded rule excludes them.

## Precedence (first-match-wins)

`… → fiscally_sponsored → insurance → [donation guard] → loan(guaranty) →
interest → tax_refund → other_revenue → earned_income → expense_refund →
membership`

- `insurance` runs before the donation guard.
- `expense_refund` runs **after** the specific guarded rules, so a genuine
  payroll-tax / tax / insurance refund coded to a `7010.4 / 7020 / 7006` account
  keeps its more specific `tax_refund` label. `expense_refund` only catches
  refund rows the guarded rules did not (wrong account, or donation-coded ERC).

The 0030 backfill mirrors this by running the `insurance` UPDATE first, then the
`expense_refund` UPDATE, both `pending`-only.

## Apply order

1. **0029 enum** — run WITHOUT `-1` (ADD VALUE can't run in a txn block):

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0029_quickbooks_insurance_expense_refund_enum.sql
   ```

2. **0030 backfill** — run WITH `-1` (single transaction):

   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0030_quickbooks_insurance_expense_refund_backfill.sql
   ```

Prerequisite: the new app code is deployed and existing rows carry line detail
(`line_description` / `line_account_names` / `line_item_names` / `line_classes`).

## Expected impact (from a read-only production probe)

- **insurance**: ~18 `pending` BASICCOBRA rows → `excluded` / `insurance`.
- **expense_refund**: ~13 `pending` "refund" rows → `excluded` / `expense_refund`,
  including the two ERC tax refunds (~$269,782 + ~$247,708) that are
  donation-coded.

Numbers are a snapshot; verify against current data.

## Manual review items (NOT handled by the backfill)

- **3 BASICCOBRA rows are already `excluded` under `tax_refund`** (they were
  auto-excluded before the `insurance` reason existed). They are already out of
  the queue, so the `pending`-only backfill does not touch them. Reclassify by
  hand only if the precise label matters:

  ```sql
  UPDATE staged_payments
     SET exclusion_reason = 'insurance', updated_at = now()
   WHERE status = 'excluded' AND exclusion_reason = 'tax_refund'
     AND lower(coalesce(line_description,'')) LIKE '%basiccobra%';
  ```

- **2 "refund" rows were already `approved` into gifts** before this rule
  existed. They are NOT reclassified here (status `<> 'pending'`) NOR by the
  in-app reclassify (it skips approved rows). If they are actually expense
  refunds, reject / unwind them per-row. Find them with:

  ```sql
  SELECT id, amount, payer_name, raw_reference, created_gift_id
    FROM staged_payments
   WHERE status = 'approved'
     AND lower(concat_ws(' ', payer_name, raw_reference, line_description)) ~ '\mrefund';
  ```

## Verification

```sql
SELECT status, exclusion_reason, count(*)
  FROM staged_payments
 GROUP BY 1, 2
 ORDER BY 1, 2;
```

Re-running either file is a no-op (`pending`-only + idempotent enum guards).
