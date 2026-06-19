---
name: Loan-capital fundraising category
description: Loan-fund capital is a fundraising track parallel to revenue across analytics; the two are never mixed and all legacy data defaults to revenue.
---

Wildflower fundraising splits into two parallel tracks that must never be mixed
in analytics: `revenue` (gifts/grants) and `loan_capital` (loan-fund investment).

**Model:**
- `fundraising_category` enum: `revenue` | `loan_capital`.
- `opportunities_and_pledges.fundraisingCategory` — NOT NULL, default `revenue`.
- `fiscal_year_entity_goals` PK is `(fiscalYearId, entityId, category)` — each
  track gets its own goal per FY/entity.
- "Loan money" = `loan_fund_investment` gifts + loan-capital opps/pledges.

**Analytics:** `dashboard-summary`, `fiscal-year-breakdown`, and projections all
split per category. Dashboard shows two tracks per fiscal year, each with
received / committed / weighted-open / goal. Goals routes take a `:category`
path param defaulting to `revenue`.

**Why:** loan capital and operating revenue are economically different money and
the org reports them separately; blending them misstates both goals and pace.

**How to apply:** any new analytic that aggregates gift/opp money must thread
`category` through and keep the two buckets separate. Non-destructive default —
all pre-existing rows are `revenue`, so a missing/absent category means revenue.
