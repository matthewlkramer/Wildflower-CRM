-- Migration 0020: Add the `earned_income` QuickBooks auto-exclude reason
--
-- Additive only — extends the staged_payment_exclusion_reason enum with one new
-- value used by the refined noise classifier:
--   earned_income — fees-for-service / program revenue posted to the "Services -
--                   Earned Income" (4020) income account. Never a gift.
--
-- ⚠️ RUN THIS *WITHOUT* -1 (no single-transaction wrapper):
--
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0020_quickbooks_earned_income_enum.sql
--
-- PostgreSQL forbids USING a newly added enum value in the SAME transaction that
-- added it. In psql's default autocommit mode the ALTER TYPE ... ADD VALUE
-- commits on its own; the backfill that USES this value lives in a SEPARATE file
-- (0021) which must run AFTER this one has committed. Do NOT pass -1 here, and do
-- NOT merge this statement into the backfill transaction.
--
-- IDEMPOTENT: IF NOT EXISTS — re-running is a harmless no-op.

ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'earned_income';

-- Verification:
--   SELECT enumlabel FROM pg_enum e
--     JOIN pg_type t ON t.oid = e.enumtypid
--    WHERE t.typname = 'staged_payment_exclusion_reason'
--    ORDER BY e.enumsortorder;
