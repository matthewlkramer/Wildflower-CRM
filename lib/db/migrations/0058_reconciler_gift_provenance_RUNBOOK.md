# Runbook — 0058_reconciler_gift_provenance

## What this does

Adds the gift **final-amount provenance** model (Phase D/E): the CRM
`gifts_and_payments` row stays the single source of truth for a money event while
being tied permanently to its reconciliation evidence (a Stripe charge or a
QuickBooks staged row) — without that evidence ever becoming a second gift.

It ships, all guarded/idempotent:

1. enum `gift_final_amount_source` — `'human' | 'stripe' | 'quickbooks'`.
2. `gifts_and_payments` columns:
   - `original_human_crm_amount numeric(14,2)` — snapshot of the human-entered
     amount before any processor stamp overwrote `amount`.
   - `final_amount_source` NOT NULL DEFAULT `'human'` — where `amount` came from.
   - `final_amount_stripe_charge_id` → `stripe_staged_charges(id)` ON DELETE
     RESTRICT.
   - `final_amount_qb_staged_payment_id` → `staged_payments(id)` ON DELETE
     RESTRICT.
3. CHECK `gifts_and_payments_final_amount_source_ptr` — source↔pointer XOR
   (`human` ⇒ both pointers NULL; `stripe` ⇒ stripe pointer only; `quickbooks` ⇒
   qb pointer only).
4. Two **partial-UNIQUE** indexes (`... IS NOT NULL`) so one evidence row is the
   final-amount source for AT MOST ONE gift.
5. `gift_amount_allocation_review` worklist table — gifts whose `amount` was
   stamped but whose allocations couldn't be auto-rebalanced (0 or 2+ that no
   longer sum); at most one OPEN row per gift.
6. **Data backfill** (step 6): `original_human_crm_amount = amount` for every
   pre-existing, still-`human`, un-stamped gift.

## Safety

- **Additive + idempotent.** The enum/columns/FKs/CHECK/indexes/table are each
  guarded (`IF NOT EXISTS` or a `pg_constraint`/`pg_type` look-up), and the step-6
  backfill self-excludes once `original_human_crm_amount` is set. Re-running is a
  no-op.
- **No destructive change.** Nothing is dropped; `amount` is never modified by this
  file (only the new snapshot column is populated). The FKs are RESTRICT, so they
  cannot cascade-delete anything.
- **FK naming.** The two FKs are added with their exact Drizzle-generated
  (63-char-truncated) names and guarded by *any* FK existing on the column (not by
  name), so a Publish-created FK is never duplicated and a later Publish diff sees
  them as already-present.

## Ordering

- **vs 0057:** independent — either order. 0058 does not use the
  `staged_payment_status = 'reconciled'` value.
- **vs Publish:** either order is safe. Publish ships the SCHEMA (columns, FKs,
  CHECK, indexes, table) via the normal Drizzle diff; if it ran first, steps 1–5
  here are no-ops. **Publish does NOT run the step-6 data backfill**, so this file
  must be applied by a human regardless of Publish to snapshot
  `original_human_crm_amount`.

## ⚠️ How to apply (production, by a human) — single transaction

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0058_reconciler_gift_provenance.sql
```

Unlike 0057, this file IS run with `-1` (it CREATEs the enum type — it does not
`ALTER TYPE ... ADD VALUE` — so the whole thing is transaction-safe).

**Locking:** `ADD COLUMN ... NOT NULL DEFAULT 'human'` plus the `ADD CONSTRAINT`
CHECK/FK each take a brief ACCESS EXCLUSIVE lock and validate existing rows. On the
current `gifts_and_payments` size this is sub-second, but run it during a quiet
window. The `CREATE INDEX` calls are plain (not `CONCURRENTLY`) because they run
inside the single transaction.

## Verify

```sql
-- enum present with all three values
SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
 WHERE t.typname = 'gift_final_amount_source' ORDER BY e.enumsortorder;

-- backfill complete: expect 0
SELECT count(*) AS unsnapshotted FROM gifts_and_payments
 WHERE original_human_crm_amount IS NULL AND final_amount_source = 'human';

-- worklist table + partial-unique pointer indexes exist
SELECT to_regclass('public.gift_amount_allocation_review') IS NOT NULL AS review_table;
SELECT indexname FROM pg_indexes
 WHERE tablename = 'gifts_and_payments'
   AND indexname IN (
     'gifts_and_payments_final_amount_stripe_charge_id_idx',
     'gifts_and_payments_final_amount_qb_staged_payment_id_idx'
   );
```
