# 0052 — Tag historical loan-fund deals as loan_capital

## What this does

Migration 0051 added `opportunities_and_pledges.fundraising_category` with a
non-destructive default of `revenue`, so every pre-existing opportunity/pledge
was classified as revenue and the dashboard's new **Loan Capital** track rendered
empty. This file re-categorizes the historical loan-fund (PRI / CDFI / program-
related-investment) deals to `loan_capital` so the second track reflects real
money.

It only ever **sets** `fundraising_category = 'loan_capital'` — it never flips a
row back to `revenue`, so a later human override to revenue survives a re-run.

## How a loan deal is identified (opportunities/pledges)

1. **Loan/debt fund entity** — any allocation booked to `sunlight_debt`
   ("Sunlight - debt"). This entity is by definition the loan-fund (debt) pool,
   distinct from `sunlight_grants` ("Sunlight - grants", revenue). On the seed
   data all 21 such opps are CDFI / PRI / loan / guarantee deals. Note: "Wells
   CDFI **grant**" (entity `sunlight_grants`) correctly stays revenue even though
   "CDFI" appears in its name — the entity, not the name, disambiguates.
2. **Receives a loan-fund-investment payment** — any opp/pledge that a
   `gifts_and_payments.type = 'loan_fund_investment'` row pays
   (`payment_on_pledge_id`). Catches loan deals booked under a non-debt entity
   (e.g. "SpringPoint PRI - Emerging Hub Revolving Loan Fund", booked with no
   entity).
3. **Explicit reviewed id list** — clear loan/PRI deals with neither a
   `sunlight_debt` allocation nor a loan payment yet. Kept as an explicit,
   human-reviewed list (not a fuzzy name match) so a "CDFI grant" is never swept
   up by accident:
   - `recbMikoIQyPlZ0uR` — "CSGF HUB LOAN"

## Gifts / payments need NO backfill

Loan-capital **gifts** are derived at query time from
`gifts_and_payments.type = 'loan_fund_investment'` (see `analytics.ts`
`giftCategorySql`). There is no `fundraising_category` column on gifts, so no
gift backfill is required. On the seed data the loan-capital "received" totals
come straight from the 5 existing `loan_fund_investment` gifts.

## Apply

Depends on 0051 (the `fundraising_category` column). Run 0051 / Publish first.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0052_tag_loan_capital_opportunities.sql
```

Expected NOTICEs on success (seed dataset):

```
0052: loan_capital opps BEFORE = 0
UPDATE 23
0052: loan_capital opps AFTER = 23 (expect 23 on the seed dataset)
```

(Prod counts will differ; the file is idempotent and re-running is a no-op.)

## Non-destructive guarantee

- Only `SET ... = 'loan_capital'`; never `= 'revenue'`. A human override back to
  revenue is preserved (`WHERE fundraising_category <> 'loan_capital'`).
- Idempotent — re-running tags nothing new.
- No schema change; only data classification.

## Verify

```sql
-- loan-capital opportunities/pledges now exist
SELECT count(*) FROM opportunities_and_pledges WHERE fundraising_category = 'loan_capital';
-- loan-capital received is derived from loan_fund_investment gifts (no backfill)
SELECT count(*), COALESCE(SUM(amount),0)
  FROM gifts_and_payments WHERE type = 'loan_fund_investment' AND archived_at IS NULL;
```

The per-FY Loan Capital track is visible on the fiscal-year breakdown drill-down
for the years that carry loan activity (seed data: FY2019–FY2024).
