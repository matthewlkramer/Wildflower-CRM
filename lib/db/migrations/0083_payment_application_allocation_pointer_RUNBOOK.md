# 0083 — Allocation pointer on the cash-application ledger

## What this changes

Adds an **optional**, nullable `gift_allocation_id` column (+ index) to
`payment_applications`, the QuickBooks cash-application ledger.

The reconciliation worklist lists one row per `gift_allocation` and offers both
"Link allocation → payment" and "Link gift → payment". Reconciliation (the
tie / book-once math) stays **per-gift** — a payment settles a *gift*. This
column simply records *which* allocation the reviewer chose on an
allocation-scoped link, so the two menu actions differ in substance:

- **Link allocation → payment** → stamps the chosen `gift_allocation_id` onto the
  ledger row.
- **Link gift → payment** → leaves it `NULL` (= recorded against the whole gift,
  the prior behavior).

The FK is `ON DELETE SET NULL`, so deleting an allocation degrades the row to
header-level rather than blocking the delete. The tie deriver never reads this
column; book-once / amount math is unchanged.

## Order of operations

1. **Publish** the new code first (normal flow). This adds
   `payment_applications.gift_allocation_id` to prod via the drizzle diff.
2. **Run the file** (idempotent, purely additive — safe whether or not Publish
   already added the column):

   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
     -f lib/db/migrations/0083_payment_application_allocation_pointer.sql
   ```

   The `NOTICE` line reports total ledger rows and allocation-scoped rows
   (expect `0` scoped right after rollout — the pointer only gets set by
   future allocation-scoped links).

## Safety

- `ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` — safe to re-run.
- **No backfill, nothing dropped.** Existing rows stay `NULL` (header-level),
  preserving prior behavior exactly.
