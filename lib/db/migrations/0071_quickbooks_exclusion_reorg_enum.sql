-- Migration 0071: QuickBooks exclusion-reason reorg — NEW enum values
--
-- Adds the new `staged_payment_exclusion_reason` values introduced by the
-- exclusion-reason reorganization. The overloaded `loan` reason is split into
-- precise families and a new manual-only outflow reason is added:
--
--   loan_repayment       — principal/interest returning on loans Wildflower MADE
--                          ("Loans to Schools" account, a "loan repayment" item,
--                          any "… Repayment" line, or a loan/repayment PAYER).
--   loan_proceeds        — borrowed funds coming IN (a liability, not income):
--                          "PPP Loan Received" / "loan received" / "loan proceeds".
--   note_payable         — a liability booking on the "Note Payable(s)" account.
--   miscoded_withdrawal  — an outflow QuickBooks recorded as a deposit / payment
--                          (manual-only; the classifier never emits it).
--
-- The legacy values `loan`, `government_reimbursement` and `fiscally_sponsored`
-- are KEPT (valid for historical rows) — the classifier simply stops emitting
-- them. Guaranty activity now folds into the pre-existing `earned_income` value.
--
-- WHY A SEPARATE FILE: PostgreSQL forbids USING a brand-new enum value in the
-- same transaction that adds it. This file (each ADD VALUE auto-commits) MUST run
-- and COMMIT before the 0072 backfill, which re-codes historical rows INTO these
-- new values. Mirrors the 0015→0016 enum/backfill split.
--
-- IDEMPOTENT: ADD VALUE IF NOT EXISTS — re-running is a no-op. Do NOT wrap in an
-- explicit transaction.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0071_quickbooks_exclusion_reorg_enum.sql

ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'loan_repayment';
ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'loan_proceeds';
ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'note_payable';
ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'miscoded_withdrawal';

-- Verify:
--   SELECT unnest(enum_range(NULL::staged_payment_exclusion_reason));
--   -- expect loan_repayment, loan_proceeds, note_payable, miscoded_withdrawal present
--   -- alongside the retained legacy loan / government_reimbursement / fiscally_sponsored.
