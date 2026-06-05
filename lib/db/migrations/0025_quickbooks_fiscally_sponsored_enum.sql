-- Migration 0025: Add the `fiscally_sponsored` QuickBooks auto-exclude reason
--
-- Additive only — extends the staged_payment_exclusion_reason enum with one new
-- value used by the refined noise classifier:
--   fiscally_sponsored — money belonging to a separate fiscally sponsored
--                        project (e.g. "Embracing Equity") that the org does NOT
--                        reconcile here. Project-identity rule (no donation
--                        guard); matched by a project marker (QuickBooks Class,
--                        payer, item, account, or memo) anywhere on the row.
--
-- ⚠️ RUN THIS *WITHOUT* -1 (no single-transaction wrapper):
--
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0025_quickbooks_fiscally_sponsored_enum.sql
--
-- PostgreSQL forbids USING a newly added enum value in the SAME transaction that
-- added it. In psql's default autocommit mode each ALTER TYPE ... ADD VALUE
-- commits on its own; the backfill that USES this value lives in a SEPARATE file
-- (0026) which must run AFTER this one has committed. Do NOT pass -1 here, and do
-- NOT merge this statement into the backfill transaction.
--
-- IDEMPOTENT: IF NOT EXISTS — re-running is a harmless no-op.

ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'fiscally_sponsored';

-- Verification:
--   SELECT enumlabel FROM pg_enum e
--     JOIN pg_type t ON t.oid = e.enumtypid
--    WHERE t.typname = 'staged_payment_exclusion_reason'
--    ORDER BY e.enumsortorder;
