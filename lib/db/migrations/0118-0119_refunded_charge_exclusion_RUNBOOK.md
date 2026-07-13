# 0118–0119 — Auto-exclude refunded money (enum + backfill) RUNBOOK

## What this ships

Fully-refunded, never-booked Stripe charges — and pending QuickBooks staged
payments whose entire Stripe trace is such charges — now land in the Excluded
tab with the new `refunded_charge` exclusion reason instead of sitting in the
live "Money unlinked to CRM record" queue as approvable money.

Named target: **Erica Cantoni's $248.19** QB payment dated 2022-02-02 (staged
payment `eY58cEjOB9rluJXXrT9d8`), the payout of Stripe charge
`ch_3KO2ePAhXr9x8yiR1TxWHAeF` ($259.11 gross, fully refunded the day it was
charged).

The code side (ships via Publish) mirrors the `failed_charge` precedent end to
end: ingest/upsert classification, refund-propagation unbooked branch, a sweep
that excludes QB rows once ties/links land, terminal-charge predicates, and
revert (re-include restores the row; reverting a gift built on a fully-refunded
charge re-lands the charge in Excluded).

## Ordering (matters)

1. **Publish first** (schema diff — creates the enum value in prod).
2. Then apply **0118** (harmless no-op after Publish; kept so the ordering is
   explicit if data is backfilled before a Publish ever runs):

   ```bash
   psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0118_refunded_charge_exclusion_enum.sql
   ```

   ⚠️ No `-1` on 0118 — Postgres forbids USING a new enum value in the same
   transaction that added it.

3. Then apply **0119** (the backfill; single transaction is fine):

   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0119_exclude_refunded_stripe_charges.sql
   ```

## What 0119 touches (and refuses to touch)

Three idempotent passes, all restricted to **derived-pending +
`classification_source = 'auto'`** rows:

1. **Charges** — fully refunded (`refunded`, not `disputed`, cumulative
   refunds ≥ gross), no gift link → `refunded_charge`.
2. **QB rows with an explicit Stripe trace** — per-charge QB ties or a
   settlement-linked payout; excluded only when ≥1 traced charge is
   `refunded_charge` AND no traced charge is live money.
3. **Conservative direct NET trace** (covers Erica — her row predates ties):
   exact net-amount match, ±20 days, single-charge payout with no links, and
   the pairing unique in BOTH directions. Ambiguity ⇒ row stays for a human.

Never touched: anything a human resolved (gift links, confirmed settlement
links, counted ledger rows), manual re-include pins, disputed charges
(chargeback path), partially refunded charges, deposits mixing refunded and
live charges, and charges already booked into gifts (those keep the existing
propose-then-confirm refund propagation).

## Verify

```sql
-- The named target row is now excluded:
SELECT id, exclusion_reason FROM staged_payments
 WHERE id = 'eY58cEjOB9rluJXXrT9d8';

-- Review everything the backfill excluded:
SELECT id, payer_name, amount, date_received
  FROM staged_payments WHERE exclusion_reason = 'refunded_charge';
SELECT id, gross_amount, amount_refunded, net_amount
  FROM stripe_staged_charges WHERE exclusion_reason = 'refunded_charge';
```

Expected: a small set — the Erica row plus any other fully-refunded
never-booked strays. Everything is revertible from the Excluded tab
(re-include pins the row `manual` so automation never re-excludes it).
