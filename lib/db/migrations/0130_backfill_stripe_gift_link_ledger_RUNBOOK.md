# Migration 0130 — Backfill Stripe gift links into payment_applications

## Purpose

`gifts_and_payments.final_amount_stripe_charge_id` is now `@deprecated` and is
no longer written by any server route.  All Stripe→gift linkage is authoritative
on `payment_applications` (`evidence_source='stripe'`, `link_role='counted'`).

This migration inserts one backfill row per gift that has the deprecated pointer
set but has no counted ledger row yet, so reads of the ledger are complete before
the pointer column is eventually dropped.

## Safety

- **Additive only** — inserts new rows; no existing rows are mutated.
- **Idempotent** — `ON CONFLICT DO NOTHING` on the unique index; safe to re-run.
- **Non-blocking** — plain `INSERT … SELECT`; no table rewrites.

## Apply to prod

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0130_backfill_stripe_gift_link_ledger.sql
```

## Verify

```bash
# Count gifts that still have the pointer set but no counted ledger row:
psql "$PROD_DATABASE_URL" -c "
  SELECT COUNT(*) AS still_missing
  FROM gifts_and_payments g
  WHERE g.final_amount_stripe_charge_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM payment_applications pa
      WHERE pa.stripe_charge_id = g.final_amount_stripe_charge_id
        AND pa.gift_id = g.id
        AND pa.link_role = 'counted'
    );
"
# Expected: 0
```

## After this migration

Once applied and verified (still_missing = 0), the `final_amount_stripe_charge_id`
column can be dropped via a subsequent reviewed SQL file.  The Drizzle schema
annotation and the `deprecated-column-drop-audit` process in memory apply.
