-- Migration 0015: Add new QuickBooks auto-exclude reasons (enum values)
--
-- Additive only — extends the staged_payment_exclusion_reason enum with three
-- new values used by the refined noise classifier:
--   interest                 — bank / investment interest income
--   government_reimbursement — government grant reimbursements (funder "CSP")
--   tax_refund               — payroll-tax / tax / insurance refunds
--                              (unemployment tax, workers-comp refund, etc.)
--
-- ⚠️ RUN THIS *WITHOUT* -1 (no single-transaction wrapper):
--
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0015_quickbooks_exclusion_reasons_enum.sql
--
-- PostgreSQL forbids USING a newly added enum value in the SAME transaction that
-- added it. In psql's default autocommit mode each ALTER TYPE ... ADD VALUE
-- commits on its own; the backfill that USES these values lives in a SEPARATE
-- file (0016) which must run AFTER this one has committed. Do NOT pass -1 here,
-- and do NOT merge these statements into the backfill transaction.
--
-- IDEMPOTENT: IF NOT EXISTS — re-running is a harmless no-op.

ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'interest';
ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'government_reimbursement';
ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'tax_refund';

-- Verification:
--   SELECT enumlabel FROM pg_enum e
--     JOIN pg_type t ON t.oid = e.enumtypid
--    WHERE t.typname = 'staged_payment_exclusion_reason'
--    ORDER BY e.enumsortorder;
