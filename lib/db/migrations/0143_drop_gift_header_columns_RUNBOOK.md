# Runbook: 0143 — Drop retired gift header columns (incl. final_amount_stripe_charge_id)

## Real environment state (verified 2026-07-21)

The 0143 file's original header claimed the drops were "already in effect in
prod". That was **false**: on 2026-07-21 all seven 0143 columns still existed
in BOTH dev and prod, and dev additionally still had
`final_amount_qb_staged_payment_id` (the 0130 drop, which prod had already
received). Dev was converged on 2026-07-21 by applying 0130 + 0143; **the prod
apply of 0143 is still pending** and must happen before/with the next Publish
(Publish diffs the dev DB — with dev now dropped, a Publish that ships first
would also drop these columns in prod, which is equivalent and fine; applying
this file is still the reviewed, explicit path).

| Column (gifts_and_payments) | Dev (after 2026-07-21) | Prod |
|---|---|---|
| `type` | dropped | **still present — pending 0143** |
| `quickbooks_tie_status` | dropped | **still present — pending 0143** |
| `final_amount_stripe_charge_id` | dropped | **still present — pending 0143** |
| `coding_form_circle/_series/_additional_notes/_memo` | dropped | **still present — pending 0143** |
| `final_amount_qb_staged_payment_id` | dropped (0130) | already absent (0130 no-op) |

## Pre-checks (run against prod first)

Confirm no non-null Stripe pointers remain (verified **0** on 2026-07-21; the
ledger backfill `0130_backfill_stripe_gift_link_ledger.sql` moved linkage to
`payment_applications`):

```sql
SELECT count(*) FROM gifts_and_payments
WHERE final_amount_stripe_charge_id IS NOT NULL;
-- Expect 0.
```

`type`, `quickbooks_tie_status`, and the `coding_form_*` columns DO still hold
values in prod — that is expected. All are fully derived at read time
(`deriveGiftTypeExpr` / `deriveGiftQbTieLiveExpr`) or folded into `tags`
(migration 0131), and no deployed code reads or writes the physical columns.

## Apply (run both, in this order — each is idempotent, safe to re-run)

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0130_drop_final_amount_qb_staged_payment_id.sql
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0143_drop_gift_header_columns.sql
```

(0130 is a no-op in prod — the column is already gone — but running it keeps
the applied-migration history identical between environments.)

## Post-verify

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'gifts_and_payments'
  AND column_name IN ('type','quickbooks_tie_status',
    'final_amount_stripe_charge_id','final_amount_qb_staged_payment_id',
    'coding_form_circle','coding_form_series',
    'coding_form_additional_notes','coding_form_memo');
-- Expect 0 rows.
```

## Rollback

No rollback path. `final_amount_stripe_charge_id` has been NULL everywhere
since the 0130 ledger backfill; the other columns' facts are derived at read
time. Re-adding any of them would violate the "one authority" invariant — the
counted `payment_applications` ledger and the derivation expressions are the
sole sources.
