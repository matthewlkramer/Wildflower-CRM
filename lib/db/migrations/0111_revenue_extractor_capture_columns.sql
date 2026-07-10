-- Migration 0111: Add Revenue Extractor capture columns (Task #607)
--
-- Task #607 (finance-facing "Revenue Extractor" report) adds three capture
-- columns so QuickBooks coding is definitively derivable from the CRM record:
--
--   gifts_and_payments.title_reference   — nullable text. The grant title or
--                                          reference number ("Title / Reference #"
--                                          column of the report).
--   gifts_and_payments.memo_description  — nullable text. The memo / description
--                                          line finance keys into QuickBooks.
--   fundable_projects.location_code      — nullable text. The QuickBooks Revenue
--                                          Location a project-specific grant codes
--                                          to when no entity coding rule and no
--                                          regional hub apply (precedence: entity
--                                          rule -> regional hub -> project location
--                                          code -> Foundation General). One of the
--                                          closed LOCATIONS list.
--
-- SAFETY / IDEMPOTENCY:
--   * Purely additive. ADD COLUMN IF NOT EXISTS makes re-running a no-op.
--   * All three are nullable text with no default (metadata-only change; no table
--     rewrite). Existing rows read NULL.
--   * Nothing is backfilled, modified, or dropped. No effect on derivation /
--     analytics / QuickBooks-tie logic.
--
-- Apply with:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0111_revenue_extractor_capture_columns.sql

ALTER TABLE gifts_and_payments
  ADD COLUMN IF NOT EXISTS title_reference text;

ALTER TABLE gifts_and_payments
  ADD COLUMN IF NOT EXISTS memo_description text;

ALTER TABLE fundable_projects
  ADD COLUMN IF NOT EXISTS location_code text;
