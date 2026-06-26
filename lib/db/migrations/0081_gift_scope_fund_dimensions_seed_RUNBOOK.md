# 0081 — Gift-scope restructure: seed fund dimensions + entity no-payment flag

## What this changes

Part of Task #448 (moving gift scope/reconciliation state OFF the
`gifts_and_payments` header onto child `gift_allocations` rows or values derived
from linked payments). This file seeds the new fund dimensions the rest of the
restructure depends on:

- **`entities.expects_payment`** — a new boolean (default `true`). A gift expects
  a payment unless ALL of its allocations sit on a no-payment entity. The column
  reaches prod via the normal Publish (drizzle) diff; this file seeds DATA only.
- **Two no-payment entities** — `direct_to_school` ("Direct to School") and
  `wildflower_foundation_tsne` ("Wildflower Foundation TSNE"), both with
  `expects_payment = false`. These replace the retired header booleans
  `designated_to_school` and `off_books_fiscal_sponsor` (the designation becomes
  an allocation ENTITY choice).
- **The `seed_fund` fundable project** ("Seed Fund") — the target for the
  school-startup designation backfill that ships in a later migration.

## Order of operations

1. **Publish** the new code first (normal flow). This adds
   `entities.expects_payment` to prod via the drizzle diff and stops all
   reads/writes of the retired header columns.
2. **Run this seed** (idempotent, additive):

   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
     -f lib/db/migrations/0081_gift_scope_fund_dimensions_seed.sql
   ```

   Confirm the `NOTICE` line reports **no-payment entities = 2** and
   **seed_fund project = 1**.

## Safety

- The column add is `IF NOT EXISTS`; entity / fundable-project seeds use
  `ON CONFLICT (id) DO NOTHING` (never overwrite an existing name); the
  `expects_payment = false` correction is guarded. The whole file is a no-op on
  re-run and never deletes a row. Safe to run before OR after the Publish (the
  defensive column add covers the before-Publish case).

## Follow-on

The data backfill that MOVES existing header designations onto allocation
entities (42 designated-to-school gifts → Wildflower Foundation + Seed Fund +
School Startup; ambiguous → `needs_research`; off-books → Wildflower Foundation
TSNE) ships as a separate, later migration (Task #448 Step 12) with its own
RUNBOOK.
