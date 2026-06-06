-- 0029_quickbooks_insurance_expense_refund_enum.sql
--
-- Adds two new AUTO staged-payment exclusion reasons:
--   * insurance      — COBRA / insurance-premium reimbursements (the "BASICCOBRA"
--                      marker on the line); never a gift.
--   * expense_refund — refunds of the org's OWN expenses (vendor overpayments,
--                      registration / training refunds, ERC tax refunds, etc.):
--                      money coming back, not a contribution.
--
-- Both are assigned by the classifier (quickbooksExclusionRules.ts) at insert
-- time AND backfilled over the existing queue by 0030 (next file).
--
-- IMPORTANT: ALTER TYPE ... ADD VALUE cannot run inside a transaction block in
-- older PostgreSQL, so run this file WITHOUT -1 (no single-transaction wrapper):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0029_quickbooks_insurance_expense_refund_enum.sql
--
-- Idempotent: IF NOT EXISTS guards make re-runs safe.

ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'insurance';
ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'expense_refund';
