# Runbook — 0057_staged_payment_status_reconciled_enum

## What this does

Adds one value, `reconciled`, to the `staged_payment_status` enum. That enum is
shared by both reconciliation-evidence tables — `staged_payments` (QuickBooks) and
`stripe_staged_charges` (Stripe). `reconciled` is the terminal state for a piece
of evidence that has been tied permanently to the CRM gift it backs:

- hidden from the live work queues (the reconciler and the legacy staged-payment /
  Stripe-reconciliation pages),
- **never archived and never deleted** — it remains as the permanent money-trail
  link between the gift and its Stripe charge / QuickBooks staged row.

## Safety

- **Additive and idempotent.** `ALTER TYPE ... ADD VALUE IF NOT EXISTS`. No
  existing rows are read or modified; no row is set to `reconciled` by this file
  (the application does that later, at confirm/approve time).
- Re-running is a no-op. The value also ships via the normal Drizzle schema diff on
  Publish; whichever path runs first, the other is a guarded no-op.

## ⚠️ How to apply (production, by a human) — NO `-1`

PostgreSQL forbids *using* a newly added enum value in the same transaction that
added it, so this `ALTER TYPE ... ADD VALUE` must commit on its own. Run it
**without** the `-1` single-transaction flag:

```bash
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0057_staged_payment_status_reconciled_enum.sql
```

Order vs Publish does not matter (guarded `IF NOT EXISTS`). Order vs 0058 does not
matter — 0058 does not use this value. The only hard rule: this must have committed
before any application code writes a row with `status = 'reconciled'` (i.e. before
the reconciler/confirm paths are exercised in prod).

## Verify

```sql
SELECT enumlabel FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
 WHERE t.typname = 'staged_payment_status'
 ORDER BY e.enumsortorder;
-- expect the list to include 'reconciled'
```
