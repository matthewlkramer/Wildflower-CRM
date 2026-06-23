# Runbook — 0068 Backfill `loan_or_grant` from legacy signals + Gary fix

## What this does

Sets the authoritative `loan_or_grant` flag (added by 0067) to `loan` for every
row the legacy signals already classify as loan, and applies one team-identified
data correction. Untouched rows stay at the 0067 default `grant`.

- **A.** `opportunities_and_pledges` `fundraising_category='loan_capital'` → `loan`
- **B.** `fiscal_year_entity_goals` `category='loan_capital'` → `loan`
- **C.** `gifts_and_payments` `type='loan_fund_investment'` → `loan`
- **D.** **Data correction** — Gary Community Investments **$320,000** gift
  `recVwuwntn8Om8PTl` (currently `type=standard_gift`): set BOTH
  `type='loan_fund_investment'` and `loan_or_grant='loan'` so the legacy signal
  and the new flag agree (clean parity, intended delta = 0). The separate $500
  Gary gift is deliberately left as `grant`.

## Ordering

Apply **after** `0067_loan_or_grant_flag.sql` (which creates the enum + columns).

## Apply

```bash
# dev
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0068_loan_or_grant_backfill.sql
```

```bash
# prod
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0068_loan_or_grant_backfill.sql
```

`psql -1` wraps the whole file in one transaction; the file has no top-level
`BEGIN/COMMIT`.

## Idempotency

Safe to re-run. Each `UPDATE` is guarded (`loan_or_grant <> 'loan'`, or an
`IS DISTINCT FROM` guard for Gary), so an already-correct row is never rewritten
and a re-run reports 0 rows affected. The backfill only ever promotes
legacy-loan rows to `loan`; it never demotes a `grant` row.

## Verify

Confirm by **state**, not by a clean exit (an id/slug-matched UPDATE can commit
yet have matched nothing — verify the row counts / values below):

```sql
SELECT count(*) AS opp_mismatch
  FROM opportunities_and_pledges
 WHERE (fundraising_category = 'loan_capital') <> (loan_or_grant = 'loan');
-- Expect 0.

SELECT count(*) AS goal_mismatch
  FROM fiscal_year_entity_goals
 WHERE (category = 'loan_capital') <> (loan_or_grant = 'loan');
-- Expect 0.

SELECT count(*) AS gift_mismatch
  FROM gifts_and_payments
 WHERE (type = 'loan_fund_investment') <> (loan_or_grant = 'loan');
-- Expect 0 (Gary's type was aligned in step D).

SELECT id, amount, type, loan_or_grant
  FROM gifts_and_payments
 WHERE id = 'recVwuwntn8Om8PTl';
-- Expect: amount 320000.00, type loan_fund_investment, loan_or_grant loan.
```

## Known follow-up (handled in A002, not here)

Changing Gary's gift `type` via raw SQL does **not** re-derive that gift's
allocation revenue-coding snapshots (revenue coding is computed in app code, not
a DB trigger). The "loan has no revenue account" reconciliation is part of the
A002 read-cutover / parity work.
