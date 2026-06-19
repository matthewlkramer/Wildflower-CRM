# 0051 — Fundraising category dimension (revenue vs loan_capital)

## What this does

Introduces a `fundraising_category` enum (`revenue` | `loan_capital`) and threads it
through the schema so loan-fund capital can be reported as a first-class track
parallel to revenue:

- `opportunities_and_pledges.fundraising_category` — NOT NULL DEFAULT `revenue`.
- `fiscal_year_entity_goals.category` — NOT NULL DEFAULT `revenue`, and the
  composite PRIMARY KEY widens from `(fiscal_year_id, entity_id)` to
  `(fiscal_year_id, entity_id, category)`.

Loan-capital **gifts** need no schema change — they are derived from the existing
`gifts_and_payments.type = 'loan_fund_investment'`.

## Non-destructive guarantee

- Both new columns are added with `NOT NULL DEFAULT 'revenue'`, so every existing
  row is classified as revenue (no behavior change to current totals).
- The goals PK widening is safe because existing rows were unique on
  `(fiscal_year_id, entity_id)` and all backfill to `category = 'revenue'`, so they
  remain unique under the new triple.
- The whole file is idempotent (guarded enum create, `ADD COLUMN IF NOT EXISTS`,
  PK swap only when the current PK has < 3 columns).

## Apply

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0051_fundraising_category_dimension.sql
```

Expected NOTICE on success:

```
0051: opps category=revenue=<N>, goals category=revenue=<M>, goals PK columns=3 (expect 3)
```

## Ordering vs Publish

The enum, columns, and widened PK also reach a fresh schema through the normal
Publish (drizzle) diff. This file is the reviewed path for applying the change to a
**live** database where the PK widening should be done deliberately rather than left
to an interactive push. It is safe to run before or after a Publish, and safe to
re-run.

## Rollback

Not required (additive). If ever needed and no `loan_capital` data exists:

```sql
ALTER TABLE fiscal_year_entity_goals
  DROP CONSTRAINT fiscal_year_entity_goals_fiscal_year_id_entity_id_category_pk,
  ADD CONSTRAINT fiscal_year_entity_goals_fiscal_year_id_entity_id_pk
    PRIMARY KEY (fiscal_year_id, entity_id);
ALTER TABLE fiscal_year_entity_goals DROP COLUMN category;
ALTER TABLE opportunities_and_pledges DROP COLUMN fundraising_category;
DROP TYPE fundraising_category;
```
