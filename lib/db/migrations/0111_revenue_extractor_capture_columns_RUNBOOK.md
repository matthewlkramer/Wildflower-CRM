# Runbook — 0111 Add Revenue Extractor capture columns

## What this does

SCHEMA-only, purely additive. Backs Task #607 (finance-facing "Revenue Extractor"
report). Adds three nullable text columns:

- `gifts_and_payments.title_reference` — the grant title or reference number shown in
  the report's "Title / Reference #" column.
- `gifts_and_payments.memo_description` — the memo / description line finance keys
  into QuickBooks.
- `fundable_projects.location_code` — the QuickBooks Revenue Location a
  project-specific grant codes to when no entity coding rule and no regional hub
  apply (precedence: entity rule → regional hub → project location code →
  Foundation General). One of the closed LOCATIONS list.

## Why it is safe

- **Purely additive.** `ADD COLUMN IF NOT EXISTS` makes re-running a no-op, so it is
  safe to run before or after Publish (Publish's schema diff will also create these
  columns; whichever runs first wins and the other is a no-op).
- **No table rewrite / no data touched.** All three are nullable text with no
  default (metadata-only change). Existing rows read `NULL`.
- **Non-destructive.** Nothing is backfilled, modified, or dropped. No effect on
  derivation / analytics / QuickBooks-tie logic.

## How to apply (prod)

The columns also propagate to prod via Publish's Drizzle schema diff. This file is
the explicit, reviewable artifact for the same change and is safe to run
independently (idempotent). To apply by hand from the repo root:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0111_revenue_extractor_capture_columns.sql
```

## Verify

```sql
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE (table_name = 'gifts_and_payments' AND column_name IN ('title_reference', 'memo_description'))
   OR (table_name = 'fundable_projects' AND column_name = 'location_code')
ORDER BY table_name, column_name;
```

Expect:
- `fundable_projects   | location_code   | text | YES`
- `gifts_and_payments  | memo_description | text | YES`
- `gifts_and_payments  | title_reference  | text | YES`
