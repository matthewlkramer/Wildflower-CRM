---
name: Loan vs revenue tracks + loan_or_grant flag
description: Two parallel money-classification tracks (loan capital vs revenue/grant); loan_or_grant is the SOLE authoritative flag; legacy fundraising_category pg enum + columns physically DROPPED (migration 0130).
---

Wildflower fundraising splits into two parallel tracks that must never be mixed in
analytics: **grant** (gifts/grants/revenue) and **loan** (loan-fund capital investment).

## Current authority (cutover + drop complete, 2026-07)

`loan_or_grant` enum (`loan | grant`) on `gifts_and_payments`,
`opportunities_and_pledges`, and `fiscal_year_entity_goals` is the ONLY classification
signal used. The legacy `fundraising_category` pg enum, `opportunities_and_pledges.fundraising_category`,
and `fiscal_year_entity_goals.category` columns have been **physically dropped** (migration 0130)
— they no longer exist in the schema or on any response.

**Semantic map (1:1):**
- `loan_capital` opps / `loan_fund_investment` gift type → `loan`
- `revenue` and all other gift types → `grant`
- `grant` means "all non-loan money" (including individual donations), NOT literally
  grant-maker grants — keep this caveat when naming UI options.

**Gift `type` is still live** (not deprecated). `type = 'loan_fund_investment'` derives
`loan_or_grant = 'loan'` via `giftTypeToLoanOrGrant()` on every gift write. Do not treat
gift `type` as a legacy field.

**Goals PK:** `(fiscal_year_id, entity_id, loan_or_grant)`. Goals routes take a
`:category` path param that normalizes both token families — both `loan`/`grant` AND
legacy `loan_capital`/`revenue` — to `loan_or_grant`.

## Analytics

`dashboard-summary`, `fiscal-year-breakdown`, projections, and all goal routes split per
`loan_or_grant`. Dashboard shows two tracks per fiscal year, each with received /
committed / weighted-open / goal. Any new analytic that aggregates gift/opp money must
thread `loan_or_grant` through and keep the two buckets separate.

**Why:** loan capital and operating revenue are economically different money and the org
reports them separately; blending them misstates both goals and pace.

## Rules that survive the drop (migration 0130)

- **`fundraising_category` pg enum and its two columns are physically dropped** —
  do not attempt to add them back. If you see a reference to this type in old migration
  files or runbooks, that is historical context only.
- **Goals `:category` path param must continue normalizing both token families** — old
  bookmarks and external callers may still send `loan_capital`/`revenue`. This is the
  `normalizeGoalCategory` helper in `fiscalYearEntityGoals.ts`.
- **`giftTypeToLoanOrGrant` is the only surviving mapper** in `@workspace/api-zod`
  (the `legacyCategoryToLoanOrGrant` / `loanOrGrantToLegacyCategory` pair was removed).
- **Non-destructive default:** all pre-existing rows are `grant`; the DB default on
  `loan_or_grant` is `'grant'`.
