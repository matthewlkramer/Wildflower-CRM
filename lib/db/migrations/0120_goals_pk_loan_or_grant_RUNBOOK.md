# 0120 — Goals PK swap to (fiscal_year_id, entity_id, loan_or_grant)

Part of the loan_or_grant cutover (finishing the phased plan whose parity gate
ran clean on prod 2026-07-13: 585 revenue↔grant, 24 loan_capital↔loan, zero
mismatches).

## What it does

- Verifies `(fiscal_year_id, entity_id, loan_or_grant)` is duplicate-free
  (raises and rolls back if not — would indicate parity drift).
- Drops the legacy PK `fiscal_year_entity_goals_fiscal_year_id_entity_id_category_pk`.
- Adds PK `fy_entity_goals_fy_entity_loan_or_grant_pk` on
  `(fiscal_year_id, entity_id, loan_or_grant)`.
- Touches **no data**; `category` stays physical and frozen (@deprecated).

## Why it must run by hand (not just Publish)

Publish diffs the dev DB and would also attempt this constraint swap, but a
reviewed idempotent file is the repo convention for anything beyond plain
additive columns — and running it *before* Publish guarantees the constraint
state prod ends up in is exactly the reviewed one.

## Order

1. Apply this file (any time — the app's goals upsert works under either PK
   until the code that stops writing `category` ships).
2. Publish the code (goals route now conflicts on the new PK).

## Apply (from repo root)

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0120_goals_pk_loan_or_grant.sql
```

## Verify

```bash
psql "$PROD_DATABASE_URL" -c "\d fiscal_year_entity_goals"
```

Expect `fy_entity_goals_fy_entity_loan_or_grant_pk PRIMARY KEY (fiscal_year_id, entity_id, loan_or_grant)`
and no `..._category_pk`.
