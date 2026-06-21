# Runbook — 0062 Staged-payment funding source + same-physical-gift grouping

## What this does

Adds, on `staged_payments`, the schema behind two new reconciliation
capabilities:

1. enum `staged_payment_funding_source`
   (`stripe | brokerage | daf | donorbox | paypal | wire_ach | check | cash | employer_match | other`)
2. enum `staged_payment_funding_source_provenance` (`auto | manual`)
3. `staged_payments.funding_source` — `staged_payment_funding_source` **NULLABLE**
4. `staged_payments.funding_source_provenance` — `... NOT NULL DEFAULT 'auto'`
5. `staged_payments.source_group_id` — `text` **NULLABLE**
6. index `staged_payments_funding_source_idx`
7. index `staged_payments_source_group_id_idx`

Purely additive — no existing data is changed or dropped.

- **`funding_source`** — WHERE the money came from / how it rendered. Distinct
  from `qb_payment_method` (the QB instrument like "Visa") and from the derived
  reconciliation funding **lane** (reconcile progress, not origin). Auto-seeded
  at ingest and human-correctable; `funding_source_provenance` protects a
  manually-set value from re-pull clobber (mirrors `entity_source`).
- **`source_group_id`** — a shared opaque id tying separately-entered
  QuickBooks records that are really ONE physical gift, grouping freely across
  deposits and dates. Pure human review state; the sync never writes it.

## Why this is a hand-applied SQL file (not just Publish)

`drizzle-kit push` currently **aborts on a pre-existing, unrelated drift** in
the live DB (`opportunities.conditions_met` tri-state). An aborted push skips
**all** additive changes, including these columns, so the Publish schema diff
cannot be trusted to land them. This idempotent file applies the additive
changes directly without approving the unrelated drop.

## Apply

Run **before** deploying the code that reads these columns (the API contract
selects `funding_source` / `funding_source_provenance` / `source_group_id`):

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0062_staged_payment_funding_source_grouping.sql
```

For production, use `$PROD_DATABASE_URL`:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0062_staged_payment_funding_source_grouping.sql
```

## Then backfill the inferred funding source

Every existing staged row lands at `funding_source = NULL` (unknown). Seed the
inferred source for historical rows (auto-only — never overwrites a `manual`
row):

```bash
pnpm --filter @workspace/api-server run backfill:funding-source
```

## Idempotency

Safe to re-run: both enums are guarded by `pg_type` checks and the
columns/indexes use `IF NOT EXISTS`. A second run is a no-op.

## Verify

```sql
SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'staged_payments'
   AND column_name IN ('funding_source','funding_source_provenance','source_group_id')
 ORDER BY column_name;
-- Expect: funding_source NULLABLE (no default); funding_source_provenance
--         NOT NULL default 'auto'; source_group_id NULLABLE.

SELECT unnest(enum_range(NULL::staged_payment_funding_source));
-- Expect: stripe, brokerage, daf, donorbox, paypal, wire_ach, check, cash,
--         employer_match, other.
```
