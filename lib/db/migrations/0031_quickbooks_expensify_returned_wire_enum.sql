-- 0031_quickbooks_expensify_returned_wire_enum.sql
--
-- Adds two new AUTO staged-payment exclusion reasons:
--   * expensify     — Expensify expense-reimbursement activity (the "expensify"
--                     marker anywhere on the row); never a gift.
--   * returned_wire — a wire transfer the org SENT that bounced back (the
--                     "returned wire" marker anywhere on the row); not an
--                     incoming contribution.
--
-- Both are assigned by the classifier (quickbooksExclusionRules.ts) at insert
-- time AND backfilled over the existing queue by 0032 (next file).
--
-- IMPORTANT: ALTER TYPE ... ADD VALUE cannot run inside a transaction block in
-- older PostgreSQL, so run this file WITHOUT -1 (no single-transaction wrapper):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0031_quickbooks_expensify_returned_wire_enum.sql
--
-- Idempotent: IF NOT EXISTS guards make re-runs safe.

ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'expensify';
ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'returned_wire';
