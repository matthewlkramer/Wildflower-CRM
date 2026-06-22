# Runbook — 0065 QuickBooks cash-application ledger (`payment_applications`)

## What this does

Phase 1 (additive only) of the QuickBooks cash-application ledger rollout. Adds
the authoritative many-to-many between QB payment records (`staged_payments`)
and the CRM gifts (`gifts_and_payments`) they settle:

1. enum `payment_application_evidence_source` (`quickbooks | stripe | donorbox`)
2. enum `payment_application_match_method` (`system | system_confirmed | human`)
3. table `payment_applications` — one row per payment↔gift booking (header
   grain; `amount_applied`; evidence source + optional `stripe_charge_id` /
   `donorbox_donation_id`; `created_the_gift` mint-ownership flag)
4. indexes — the `UNIQUE(payment_id, gift_id)` book-once key + lookup indexes

Purely additive — **no data is changed or dropped**. The table starts **empty**:
in Phase 1 no code writes to it and no read depends on it (zero behaviour
change). Dual-write + backfill arrive in a later phase behind their own reviewed
SQL file.

## Why this is a hand-applied SQL file (not just Publish)

`drizzle-kit push` currently **aborts on a pre-existing, unrelated drift** in
the live DB (`opportunities.conditions_met` tri-state). An aborted push skips
**all** additive changes, including this table, so the Publish schema diff
cannot be trusted to land them. This idempotent file applies the additive
changes directly without approving the unrelated drop.

## Ordering

Requires `staged_payments`, `gifts_and_payments`, `users`,
`stripe_staged_charges`, and `donorbox_donations` (migration 0064) to already
exist. Apply **after 0064 / after Publish has created `donorbox_donations`**.

### Deploy ordering (important)

Apply this file to prod **before the code that references the table goes live**.
Even in Phase 1 the gift-merge guard queries `payment_applications` on every
merge, and the QB-revert / Stripe-revert paths delete from it before a gift
hard-delete. If the new code is live before the table exists, those routes fail
with `relation "payment_applications" does not exist`. Because Publish's drizzle
diff may abort on the unrelated `conditions_met` drift (skipping this additive
create), do not rely on Publish alone — run this SQL on prod first, then deploy.

## Apply

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0065_payment_applications_ledger.sql
```

For production, use `$PROD_DATABASE_URL`:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0065_payment_applications_ledger.sql
```

## Idempotency

Safe to re-run: the enums are guarded by `pg_type` checks and the table +
indexes use `IF NOT EXISTS`. A second run is a no-op.

## Verify

```sql
SELECT to_regclass('payment_applications');                          -- not null
SELECT unnest(enum_range(NULL::payment_application_evidence_source)); -- quickbooks, stripe, donorbox
SELECT unnest(enum_range(NULL::payment_application_match_method));    -- system, system_confirmed, human
SELECT indexname FROM pg_indexes
  WHERE tablename = 'payment_applications' ORDER BY indexname;
SELECT conname FROM pg_constraint
  WHERE conrelid = 'payment_applications'::regclass ORDER BY conname;
-- Expect the 3 CHECK constraints + the FKs + the unique index.
```

## Rollback

The table is empty and unread in Phase 1, so it can be dropped cleanly if the
rollout is abandoned before dual-write:

```sql
DROP TABLE IF EXISTS payment_applications;
DROP TYPE IF EXISTS payment_application_match_method;
DROP TYPE IF EXISTS payment_application_evidence_source;
```
