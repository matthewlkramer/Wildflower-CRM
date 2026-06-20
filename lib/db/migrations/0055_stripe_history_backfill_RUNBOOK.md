# Runbook — 0055_stripe_history_backfill

## What this does

Loads a full Stripe **"Balance history"** CSV export
(`attached_assets/balance_history_1781913987279.csv`, 458 data rows) into
`stripe_payouts` + `stripe_staged_charges` so the historical Stripe money shows
up in the Stripe ↔ QuickBooks reconciliation queue alongside everything else.

- **162 payouts** (`stripe_payouts`) — 161 `paid`, 1 `failed`.
- **287 staged charges** (`stripe_staged_charges`) — 276 `charge` + 11 legacy
  `payment` rows, all staged `status='pending'`, `match_status='unmatched'`.

### Which Stripe account this is

Every id in the export carries the **`AhXr9x8yiR`** infix, i.e. it belongs to
**`acct_1DF6BFAhXr9x8yiR`** — a **prior** Stripe account, *not* the live
connector account (`acct_1TjtNWPwv36b7m2T`). The ongoing API sync runs against
the connector account and is watermark-based (ongoing-only), so this historical
back-catalogue can **only** be loaded from the CSV. All rows are stamped
`stripe_account_id = 'acct_1DF6BFAhXr9x8yiR'`.

This is safe to load even though the reconciliation queue already de-dupes Stripe
charges against the coarse QuickBooks deposit/payout lumps — that is exactly the
workflow these rows feed into.

### Field semantics (mirrors `stripeSync.ts`)

- **Payout rollups** follow `rollupPayout()`: `gross_total` = Σ charge/payment
  amount, `refund_total` = Σ |refund|, `fee_total` = Σ *all* txns' fees,
  `net_total` = gross − fee − refund, `charge_count` = # of charge/payment rows.
- **`amount`** (the bank-net that actually landed) comes from each payout row's
  own `Net`, **not** the rollup. For 5 old payouts (2021/2022/2024) that involve
  refunds / adjustments / a payout-failure clawback, `amount` and `net_total`
  intentionally differ — this is the *same* imperfection the live `rollupPayout`
  would produce, because it does not fold adjustments / payment_failure_refunds
  into the rollup. The authoritative figure is `amount`.
- **`date_received`** is the charge time converted to **America/Chicago**
  (`chargeDateReceived`).
- **`metadata`** is rebuilt from the export's `*(metadata)` columns (donorbox_*,
  description) as jsonb; `payer_name` / `payer_email` come from
  `donorbox_name` / `donorbox_email` (email falls back to the `from <email>`
  token in the description).

### Donor matching is intentionally NOT baked in

Charges import `match_status='unmatched'` with **no donor / gift / intermediary
foreign keys**. Donor identity is environment-specific (dev and prod donor PKs can
drift), so baking dev-resolved donor ids into a file applied to prod would risk
FK violations. Resolve donors **per environment** afterward — via the Stripe
reconciliation queue (`/stripe-reconciliation`) or a matcher run. This keeps the
file byte-for-byte identical and safe for **both** dev and prod.

## Safety

- **Additive + idempotent.** Two `INSERT … ON CONFLICT (id) DO NOTHING`
  statements (payouts first so the `stripe_payout_id` FK holds, then charges).
  Re-running is a no-op (verified: second apply = `INSERT 0 0`), and any row the
  ongoing sync later pulls is left untouched.
- **No schema dependency.** The `stripe_*` tables/columns already exist in
  production, and no donor/gift/intermediary FKs are written, so this does **not**
  depend on any pending schema Publish — apply it any time.
- Applied + verified in **development** already (162 + 287 rows; 0 dangling FKs;
  Σ gross $102,176.76; Σ payout bank-net $98,316.59).

## Preflight (production, before apply)

```sql
-- Tables must already exist (they ship with the schema; no Publish needed):
SELECT to_regclass('public.stripe_payouts')        AS payouts_tbl,
       to_regclass('public.stripe_staged_charges')  AS charges_tbl;   -- both non-null

-- Nothing for the prior account yet (expect 0 / 0 on a first apply; 162 / 287 if
-- already applied — either way the apply below is a safe no-op for existing rows):
SELECT
  (SELECT count(*) FROM stripe_payouts        WHERE stripe_account_id='acct_1DF6BFAhXr9x8yiR') AS payouts,
  (SELECT count(*) FROM stripe_staged_charges WHERE stripe_account_id='acct_1DF6BFAhXr9x8yiR') AS charges;
```

## How to apply (production, by a human)

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0055_stripe_history_backfill.sql
```

Expected output: `INSERT 0 162` then `INSERT 0 287` (or `INSERT 0 0` twice if
already applied).

## Verify

```sql
-- Row counts (expect 162 / 287):
SELECT
  (SELECT count(*) FROM stripe_payouts        WHERE stripe_account_id='acct_1DF6BFAhXr9x8yiR') AS payouts,
  (SELECT count(*) FROM stripe_staged_charges WHERE stripe_account_id='acct_1DF6BFAhXr9x8yiR') AS charges;

-- No dangling payout FK (expect 0):
SELECT count(*) FROM stripe_staged_charges c
 WHERE c.stripe_payout_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM stripe_payouts p WHERE p.id = c.stripe_payout_id);

-- Totals (expect gross 102176.76, payout bank-net 98316.59):
SELECT to_char(sum(gross_amount),'FM999999990.00') AS sum_gross
  FROM stripe_staged_charges WHERE stripe_account_id='acct_1DF6BFAhXr9x8yiR';
SELECT to_char(sum(amount),'FM999999990.00') AS sum_payout_amount
  FROM stripe_payouts WHERE stripe_account_id='acct_1DF6BFAhXr9x8yiR';

-- One unsettled charge has no Transfer, so stripe_payout_id IS NULL (expect 1).
-- This is expected: it never settled into a payout and therefore cannot be
-- payout↔QuickBooks reconciled until/unless a payout for it appears.
SELECT count(*) AS unsettled_no_payout
  FROM stripe_staged_charges
 WHERE stripe_account_id='acct_1DF6BFAhXr9x8yiR' AND stripe_payout_id IS NULL;
```

## Regenerating (if the CSV is re-exported)

```bash
node lib/db/src/generate-stripe-history-sql.mjs [input.csv] [output.sql]
```

Deterministic (rows sorted by id), so a re-export with the same data produces an
identical file.
