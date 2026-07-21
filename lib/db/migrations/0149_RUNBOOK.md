# 0149 — Drop deprecated source-link pointer columns

## What this does

Drops the 5 retired cross-processor pointer columns now that the
`source_links` ledger is the sole authority:

- `stripe_staged_charges.linked_qb_staged_payment_id`
- `stripe_staged_charges.proposed_qb_staged_payment_id`
- `stripe_staged_charges.linked_fee_qb_staged_payment_id`
- `donorbox_donations.linked_qb_staged_payment_id`
- `donorbox_donations.linked_stripe_charge_id`

plus their indexes. All application reads and writes already use
`source_links` exclusively; the dual-writes were removed in the same change.

## Preconditions

1. Publish the code change that removes the dual-writes FIRST (columns must
   be unreferenced by the running server before the drop).
2. Drift check was verified clean against prod (pointer mirrors ⇔ ledger,
   all 10 checks = 0; Donorbox pointers all NULL in prod) before the drop.

## Apply (human-run, from the project root)

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0149_drop_source_link_pointer_columns.sql
```

Idempotent — safe to re-run.

## Verify

```bash
psql "$PROD_DATABASE_URL" -Atc "select count(*) from information_schema.columns where (table_name='stripe_staged_charges' and column_name in ('linked_qb_staged_payment_id','proposed_qb_staged_payment_id','linked_fee_qb_staged_payment_id')) or (table_name='donorbox_donations' and column_name in ('linked_qb_staged_payment_id','linked_stripe_charge_id'));"
```

Expected: `0`.

## Rollback

None needed — the ledger holds all tie facts. Re-adding the columns would
require a backfill from `source_links` (see `docs/adr-source-link-ledger.md`),
but there is no code path that reads them anymore.
