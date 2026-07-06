# Runbook — 0103 Add bookable-gift capture columns

## What this does

SCHEMA-only, purely additive. Adds two columns to `gifts_and_payments`:

- `awaiting_settlement boolean NOT NULL DEFAULT false`
- `source_record_url text` (nullable)

Both back Task #585 (bookable-gift SOP & incomplete-gift queue):

- `awaiting_settlement` is set true when a gift is minted proactively from an
  opportunity that is about to settle ("won gift awaiting imminent payment"). While
  true, the fresh gift is excluded from the gifts-missing-QuickBooks queue so it is
  not flagged as a reconciliation error during the brief pre-payment window.
- `source_record_url` records a link to the online source record the money came
  from (e.g. a Donorbox donation). It is one of the two accepted forms of
  restriction evidence: a `donor_restricted` gift is bookable when it has EITHER a
  grant-letter URL OR this link.

## Why it is safe

- **Purely additive.** `ADD COLUMN IF NOT EXISTS` makes re-running a no-op, so it
  is safe to run before or after Publish (Publish's schema diff will also create
  these columns; whichever runs first wins and the other is a no-op).
- **No table rewrite / no data touched.** `awaiting_settlement` uses a constant
  `DEFAULT false`, which on PostgreSQL 11+ is a metadata-only change (brief
  `ACCESS EXCLUSIVE` to update the catalog, no row rewrite). `source_record_url`
  is nullable with no default. Existing rows read `false` / `NULL`.
- **Non-destructive.** Nothing is backfilled, modified, or dropped.

## How to apply (prod)

The columns also propagate to prod via Publish's Drizzle schema diff. This file is
the explicit, reviewable artifact for the same change and is safe to run
independently (idempotent). To apply by hand from the repo root:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0103_bookable_gift_capture_columns.sql
```

## Verify

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'gifts_and_payments'
  AND column_name IN ('awaiting_settlement', 'source_record_url')
ORDER BY column_name;
```

Expect:
- `awaiting_settlement | boolean | NO  | false`
- `source_record_url  | text    | YES |`
