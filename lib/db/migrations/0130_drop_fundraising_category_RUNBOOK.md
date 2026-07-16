# Migration 0130 — Drop legacy `fundraising_category` columns and enum

## Context

The `loan_or_grant` cutover (migrations 0067 / 0068 / 0120) is complete. The
app has read and written only the `loan_or_grant` flag since the 0120 migration
was applied and a full prod cycle ran. The legacy columns and enum have been
`@deprecated` (physical-only, never written or read by the API) since the
cutover.

This migration physically drops:
- `opportunities_and_pledges.fundraising_category` (`revenue` / `loan_capital`)
- `fiscal_year_entity_goals.category` (same enum)
- The `fundraising_category` pg enum itself

## Precondition check

Confirm the prod code is running on the post-cutover build (loan_or_grant is the
sole source of truth) and migration 0120 has been applied:

```sql
-- Should return 0 if the column still exists and all rows already have
-- loan_or_grant set correctly (no rows should rely on fundraising_category):
SELECT count(*)
FROM opportunities_and_pledges
WHERE loan_or_grant IS NULL;
-- Expected: 0
```

## Apply

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0130_drop_fundraising_category.sql
```

## Verify

```sql
-- All three should return 0 rows / errors indicating the objects are gone:
SELECT column_name FROM information_schema.columns
WHERE table_name = 'opportunities_and_pledges'
  AND column_name = 'fundraising_category';
-- Expected: 0 rows

SELECT column_name FROM information_schema.columns
WHERE table_name = 'fiscal_year_entity_goals'
  AND column_name = 'category';
-- Expected: 0 rows

SELECT typname FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.typname = 'fundraising_category' AND n.nspname = 'public';
-- Expected: 0 rows
```

## Rollback

There is no automated rollback. The columns contained only frozen legacy data
(all rows with `fundraising_category='revenue'` → `loan_or_grant='grant'`;
`'loan_capital'` → `'loan'`). The mapping was verified to be 100% consistent
before the cutover (parity script exit-0). If needed, recreate manually:

```sql
CREATE TYPE public.fundraising_category AS ENUM ('revenue', 'loan_capital');
ALTER TABLE opportunities_and_pledges
  ADD COLUMN fundraising_category public.fundraising_category NOT NULL DEFAULT 'revenue';
ALTER TABLE fiscal_year_entity_goals
  ADD COLUMN category public.fundraising_category NOT NULL DEFAULT 'revenue';
-- Then backfill from loan_or_grant if needed:
UPDATE opportunities_and_pledges
  SET fundraising_category = CASE WHEN loan_or_grant = 'loan' THEN 'loan_capital'::fundraising_category
                                  ELSE 'revenue'::fundraising_category END;
UPDATE fiscal_year_entity_goals
  SET category = CASE WHEN loan_or_grant = 'loan' THEN 'loan_capital'::fundraising_category
                      ELSE 'revenue'::fundraising_category END;
```
