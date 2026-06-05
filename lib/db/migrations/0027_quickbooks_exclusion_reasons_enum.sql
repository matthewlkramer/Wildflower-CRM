-- 0027_quickbooks_exclusion_reasons_enum.sql
--
-- Adds two new MANUAL-ONLY staged-payment exclusion reasons:
--   * intercompany_transfer — money moved between the org's own entities/accounts
--   * other                 — catch-all when no specific category fits
--
-- These are never auto-assigned by the classifier; a fundraiser picks them in the
-- reconciler. No backfill is needed (no existing rows use them).
--
-- IMPORTANT: ALTER TYPE ... ADD VALUE cannot run inside a transaction block in
-- older PostgreSQL, so run this file WITHOUT -1 (no single-transaction wrapper):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0027_quickbooks_exclusion_reasons_enum.sql
--
-- Idempotent: IF NOT EXISTS guards make re-runs safe.

ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'intercompany_transfer';
ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'other';
