# 0042 — Loan-by-line re-sweep runbook

## What this does

Re-runs the `loan` line/memo classifier rule over the existing QuickBooks review
queue, moving any **pending, auto-classified** row that carries a loan/repayment
marker on its line detail to `status='excluded'`, `exclusion_reason='loan'`.
Nothing is deleted.

It is the idempotent, pending-only sibling of the loan half of `0033` — narrowed
to loans only (no COBRA) and with one deliberate safety improvement: it also
guards `classification_source = 'auto'` (see below).

## Why it exists (diagnosis)

A fundraiser reported a stuck **$25,000 "LOAN REPAYMENT" from "Flor do Loto"**
(posting account `Loans to Schools`, ~2023-05-05) sitting in the review queue.

This is **not a classifier pattern gap.** `isLoanLineOrText` in
`artifacts/api-server/src/lib/quickbooksExclusionRules.ts` already matches a
`LOAN REPAYMENT` item and a `Loans to Schools` account — there is even a unit
test for exactly that shape (`"excludes a 'LOAN REPAYMENT' line item as loan
(generic payer)"`). So no patterns were changed and no test was added.

The cause is **operational**: the classifier runs **only at INSERT time**, and
the watermark-based incremental sync never re-classifies historical rows. The
Flor row was staged before the loan-line rule existed (and/or before its line
detail was enriched), stayed pending, and was eventually excluded **by hand**
(its `classification_source` is `manual`, with no `matched_rule_id`). `0033` swept
the queue once on 2026-06-06; this re-sweep catches any loan-line rows that have
arrived or been re-enriched **since**, so the same stuck-loan situation cannot
recur silently after future syncs.

## Lockstep with the engine

Mirrors `classifyStagedPayment()` / `isLoanLineOrText()` exactly:

- **Guarded line rule.** A `loan`/`loans`/`repayment` whole-word marker
  (`~* '\m(loans?|repayment)\M'`, word-anchored + plural-aware) on the
  **raw reference / line description / line item / posting account** — the same
  four fields the code scans. Deliberately does **not** scan `line_classes` or
  `qb_transaction_memo` (neither is in `isLoanLineOrText`; scanning them would
  drift from the engine and risk false positives).
- **Donation-first guard.** Skips rows that also carry a real donation line (a
  `4000`/`4100` posting account or a `Donation` item), so a gift bundled with a
  loan reference is never hidden.

## Safety / idempotency

- Touches only rows with `status='pending'` **AND** `classification_source='auto'`
  — mirroring `reclassifyStagedPayments()`. A `manual` row (a human exclude **or**
  a human re-include back into the queue) is permanent and is never re-excluded.
  > **Note vs 0033:** 0033 guarded only on `status='pending'`. Adding the
  > `classification_source='auto'` guard here is a deliberate correctness fix —
  > without it, a fundraiser who had re-included a loan-line row (deciding it IS a
  > gift) would have it silently re-excluded.
- Approved / rejected / already-excluded rows are never modified. Re-running is a
  clean no-op.
- Reuses the existing `loan` `exclusion_reason` value — no enum change.

## Expected impact (prod, read-only check 2026-06-17, pre-apply)

| Situation | Result |
|-----------|--------|
| The two known Flor do Loto rows | already `excluded='loan'` (`classification_source='manual'`) — untouched |
| Pending rows carrying a loan/repayment line marker | **0** |
| Net rows changed by this migration today | **0 (no-op)** |

It is delivered as the durable, idempotent re-sweep to run after future syncs,
not because there is anything to fix in the queue right now.

> The $75,000 Flor do Loto deposit line (`xBe80JHAOO0pyt6c5uVlh`, posted to
> `702 Grants to Schools` with the loan marker only on its **line class**) is
> already manually excluded and is intentionally **out of scope** here:
> `isLoanLineOrText` does not scan line classes, so auto-classifying it would
> require a broader pattern change (and carries false-positive risk). Left as a
> known follow-up rather than silently broadening the rule.

## Prerequisites

1. App code with `isLoanLineOrText` is deployed (it is).
2. Rows carry line detail (`line_account_names` etc.). Rows missing line detail
   can't be classified by line — see the watermark / full-re-pull note in the
   `0024` runbook if a back-catalog ever needs re-enrichment first.

## Apply

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0042_quickbooks_loan_line_resweep.sql
```

## Verify

```sql
-- Snapshot the queue before/after — 'loan' should rise by however many pending
-- auto rows matched (expected 0 today).
SELECT status, exclusion_reason, count(*)
FROM staged_payments
GROUP BY 1, 2
ORDER BY 1, 2;

-- Should return 0 after apply (nothing left in the queue matching the loan rule):
SELECT count(*) FROM staged_payments
 WHERE status='pending'
   AND classification_source='auto'
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names,'{}'::text[])) a WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names,'{}'::text[])) li WHERE lower(btrim(li)) LIKE '%donation%')
   AND ( coalesce(raw_reference,'') ~* '\m(loans?|repayment)\M'
      OR coalesce(line_description,'') ~* '\m(loans?|repayment)\M'
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names,'{}'::text[])) x WHERE x ~* '\m(loans?|repayment)\M')
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names,'{}'::text[])) x WHERE x ~* '\m(loans?|repayment)\M') );
```

Re-running the migration is a clean no-op.
