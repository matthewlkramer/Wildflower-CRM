# 0033 — Loan-by-line + COBRA backfill runbook

## What this does

Closes two QuickBooks-review-queue gaps a fundraiser reported ("lots of cards
that have loan repayment as a line item or somewhere else on the record. Cobra
too."):

- **Part A — COBRA → `insurance`.** The marker was the contiguous token
  `basiccobra`; real deposits read `COBRA TRUST ACCT BASICPacif…` / `… Cobra`
  (posted to `2002 Benefit Liability`), so only the separate word **COBRA** is
  present. The marker is now `cobra` (it subsumes `basiccobra`). Identity rule —
  matched anywhere on the row, **no** donation-first guard.
- **Part B — loan / repayment on the LINE → `loan`.** The `loan` rule matched
  only the payer name; school loans with a generic/blank payer carry the marker
  on the line instead (`Loans to Schools`, `PPP Loan Received`, `LOAN REPAYMENT`
  item, `… Repayment` description). Guarded rule — **honors** the donation-first
  guard (skips rows that also carry a 4000/4100 donation account or a "Donation"
  item), word-anchored + plural-aware.

Both are `status='pending'`-only and idempotent. Nothing is deleted.

## Prerequisites

1. **App code deployed** with the `cobra` marker + `isLoanLineOrText` rule
   (`artifacts/api-server/src/lib/quickbooksExclusionRules.ts`).
2. **0029 applied** (it added `insurance` to the `exclusion_reason` enum). ✅
   confirmed applied in production. Without it Part A would error; with it Part A
   is safe.
3. Rows carry line detail (`line_account_names` etc.) — confirmed (3,033 rows).

## Expected impact (verified against production, 2026-06-06, pre-apply)

| Part | Reason set | Rows |
|------|------------|------|
| A    | `insurance` (cobra) | **31** |
| B    | `loan` (line/memo)  | **35** |
| A ∩ B overlap | — | **0** |

Part A runs first (insurance outranks loan); Part B is pending-only so it can
never relabel an already-excluded COBRA row.

## Reviewer note (Part B label nuance)

A few Part B rows are repayments of the org's OWN expenses posted to
`7016 …Transportation, Hotel & Housing Costs` ("Repayment of the accidental
personal charges…", "Castle repayment of duplicate…"). They are genuine
non-gifts and get labeled **`loan`** here because they carry "repayment" (and no
"refund" token). If you prefer they read `expense_refund`, recode by hand after
this runs — the important outcome (out of the gift queue) is the same.

## Apply

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0033_quickbooks_loan_line_cobra_backfill.sql
```

## Verify

```sql
-- Should show 'insurance' up by ~31 and 'loan' up by ~35 vs the pre-apply snapshot.
SELECT status, exclusion_reason, count(*)
FROM staged_payments
GROUP BY 1, 2
ORDER BY 1, 2;

-- Should both return 0 after apply (nothing left in the queue matching either rule):
SELECT count(*) FROM staged_payments
 WHERE status='pending'
   AND ( coalesce(payer_name,'') ILIKE '%cobra%' OR coalesce(raw_reference,'') ILIKE '%cobra%'
      OR coalesce(line_description,'') ILIKE '%cobra%'
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names,'{}'::text[])) x WHERE x ILIKE '%cobra%')
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names,'{}'::text[])) x WHERE x ILIKE '%cobra%')
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_classes,'{}'::text[])) x WHERE x ILIKE '%cobra%') );

SELECT count(*) FROM staged_payments
 WHERE status='pending'
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names,'{}'::text[])) a WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names,'{}'::text[])) li WHERE lower(btrim(li)) LIKE '%donation%')
   AND ( coalesce(raw_reference,'') ~* '\m(loans?|repayment)\M'
      OR coalesce(line_description,'') ~* '\m(loans?|repayment)\M'
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names,'{}'::text[])) x WHERE x ~* '\m(loans?|repayment)\M')
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names,'{}'::text[])) x WHERE x ~* '\m(loans?|repayment)\M') );
```

Re-running the migration is a clean no-op.
