# Runbook — 0067 Authoritative `loan_or_grant` flag (additive schema)

## What this does

Adds the single authoritative loan-vs-grant classification (PHASE 1, additive
only — dual-written but not yet read):

1. enum `loan_or_grant` (`loan | grant`)
2. `gifts_and_payments.loan_or_grant` — `loan_or_grant NOT NULL DEFAULT 'grant'`
3. `opportunities_and_pledges.loan_or_grant` — `loan_or_grant NOT NULL DEFAULT 'grant'`
4. `fiscal_year_entity_goals.loan_or_grant` — `loan_or_grant NOT NULL DEFAULT 'grant'`

Semantic map (1:1): `loan_capital` / `loan_fund_investment` → `loan`; `revenue` /
every other gift type → `grant`. **`grant` means ALL non-loan money** (individual
donations, foundation grants, earned revenue, …), not literally only grants.

Purely additive — no existing data is changed or dropped.

## Why this is a hand-applied SQL file (not just Publish)

`drizzle-kit push` / the Publish schema diff currently **abort on a pre-existing,
unrelated drift** in the live DB (`opportunities.conditions_met` tri-state). An
aborted push skips **all** additive changes, including these columns, so the
Publish diff cannot be trusted to land them. This idempotent file applies the
additive changes directly without approving the unrelated drop.

## Apply

Run **before** 0068 (the backfill) and **before** deploying any code that reads
`loan_or_grant`.

```bash
# dev
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0067_loan_or_grant_flag.sql
```

For production, use `$PROD_DATABASE_URL`:

```bash
# prod
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0067_loan_or_grant_flag.sql
```

`psql -1` wraps the whole file in one transaction; the file deliberately has no
top-level `BEGIN/COMMIT` (only the PL/pgSQL `DO $$ … $$` enum guard).

## Then backfill

Every existing row lands at the default `grant`. Set the real loan rows + the
Gary data correction next:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0068_loan_or_grant_backfill.sql
```

## Idempotency

Safe to re-run: the enum is guarded by a `pg_type` check and the columns use
`IF NOT EXISTS`. A second run is a no-op.

## Verify

```sql
SELECT unnest(enum_range(NULL::loan_or_grant));
-- Expect: loan, grant

SELECT table_name, column_name, udt_name, column_default, is_nullable
  FROM information_schema.columns
 WHERE column_name = 'loan_or_grant'
 ORDER BY table_name;
-- Expect 3 rows, all NOT NULL DEFAULT 'grant'::loan_or_grant.
```
