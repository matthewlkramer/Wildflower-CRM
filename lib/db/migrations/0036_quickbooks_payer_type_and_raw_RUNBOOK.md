# Runbook — 0036 QuickBooks payer type + raw capture (non-destructive backfill)

Adds the QuickBooks payer-type enum + ~14 nullable capture columns to
`staged_payments`, then backfills every existing staged row with the new fields
via a **non-destructive full re-pull** that preserves ALL review state.

Apply `0036_quickbooks_payer_type_and_raw.sql` to **production** by hand (it only
adds the type + columns), then trigger the full re-pull from the app or CLI.

## Why

`staged_payments` stored only a handful of derived QB facts (amount, payer name,
line coding). The reconciler needs more context — most importantly the QB payer
**type** (Vendor / Customer / Employee), plus payment method, check number,
deposit bank account, doc number, billing address, currency, linked txns and the
**verbatim raw QB JSON** — to disambiguate matches. The incremental,
watermark-based sync never re-pulls the back-catalog, so existing rows
(~286 pending / ~472 approved / ~2476 excluded) would stay blank until each row
happens to be edited in QB.

## Difference from 0024 (do NOT reuse 0024 here)

`0024_quickbooks_clean_reingest.sql` is **destructive** — it `DELETE`s every
staged row and resets the watermark, discarding all review state. That is the
wrong tool for a pure field backfill. This operation is the **non-destructive**
alternative: it only re-enriches read-only QB capture columns and never touches
`status`, donor match, exclusion reason, grouping, gift links or `auto_applied`.

## What the SQL does

- `CREATE TYPE quickbooks_payer_type` `[vendor, customer, employee]` (guarded).
- `ALTER TABLE staged_payments ADD COLUMN IF NOT EXISTS …` for the ~14 new
  nullable columns (`qb_payer_type`, `qb_payer_id`, `qb_payment_method`,
  `qb_check_number`, `qb_deposit_to_account_name`, `qb_doc_number`,
  `qb_billing_address`, `qb_transaction_memo`, `qb_currency`, `qb_exchange_rate`,
  `qb_create_time`, `qb_linked_txn` jsonb, `qb_raw` jsonb, `qb_raw_line` jsonb).

It does **not** delete or modify any existing row, and does **not** touch
`gifts_and_payments` / `gift_allocations`.

> Note: production gets the columns automatically via the normal Publish schema
> diff. Applying this SQL by hand is still safe (idempotent) and lets you backfill
> before the next deploy if needed.

## Pre-checks (read-only)

```sql
-- Queue volume by status — capture these counts to compare after the re-pull.
SELECT status, count(*) FROM staged_payments GROUP BY 1 ORDER BY 1;

-- New columns should all be NULL before the re-pull.
SELECT count(*) FILTER (WHERE qb_payer_type IS NOT NULL) AS has_payer_type,
       count(*) FILTER (WHERE qb_raw IS NOT NULL)        AS has_raw
FROM staged_payments;
```

## Apply (schema only)

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0036_quickbooks_payer_type_and_raw.sql
```

Idempotent — safe to re-run (guarded `CREATE TYPE` + `ADD COLUMN IF NOT EXISTS`).

## Then: full re-pull to backfill (non-destructive)

The full re-pull ignores the watermark, re-fetches the entire QB back-catalog and
upserts every unit. On conflict it refreshes ONLY the read-only QB capture
columns (`coalesce(excluded.x, stored.x)`) with the status `setWhere` guard
dropped, so approved / rejected / excluded rows also get the new fields while
their review columns stay untouched. The watermark never regresses.

Pick one trigger:

- **App (admin):** open **QuickBooks Reconciliation** → **Re-pull all fields**.
- **CLI:**

  ```bash
  pnpm --filter @workspace/api-server run resync:quickbooks
  ```

- **HTTP (admin session):** `POST /api/quickbooks/resync-full`.

The first run pulls the full history, so it can take a while. If it reports
"already in progress", wait and re-check.

## Post-backfill verification (read-only)

```sql
-- Most rows now carry a payer type + raw JSON (rows with no QB entity payer may
-- legitimately stay NULL — e.g. deposit lines QB recorded without an Entity).
SELECT count(*) FILTER (WHERE qb_payer_type IS NOT NULL) AS has_payer_type,
       count(*) FILTER (WHERE qb_raw IS NOT NULL)        AS has_raw,
       count(*)                                          AS total
FROM staged_payments;

-- Payer-type distribution.
SELECT qb_payer_type, count(*) FROM staged_payments GROUP BY 1 ORDER BY 2 DESC;

-- Review state is UNCHANGED — compare against the pre-check counts.
SELECT status, count(*) FROM staged_payments GROUP BY 1 ORDER BY 1;
```

The status counts must match the pre-check exactly. If they differ, the re-pull
touched review state (it must not) — investigate before continuing.

## Rollback

Schema columns are additive and nullable; leaving them in place is harmless. The
backfill only ever populates read-only QB capture fields, so there is nothing to
undo. If you must remove the columns, drop them (and the type) manually — but the
schema expects them, so prefer leaving them.
