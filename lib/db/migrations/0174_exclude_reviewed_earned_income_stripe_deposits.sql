-- 0174: one-time exclusion of 121 reviewed earned-income Stripe-transfer deposits.
--
-- These are QBO deposit records (funding_source='stripe') whose sole line
-- account is "4020 Services - Earned Income", that settled a payout-less
-- Stripe-transfer bank deposit (the 2019-2020 fee-for-service transfers the
-- user reviewed). Excluding them mirrors the in-app exclude action:
-- exclusion_reason IS the exclusion (status is derived) and
-- classification_source = 'manual' pins it so the re-runnable classifier
-- never re-includes or re-classifies the row.
--
-- This is a one-time backfill of an explicitly reviewed set, NOT a standing
-- rule: "Split income" deposits (multi-account) are deliberately excluded from
-- the scope, and no future 4020 record is touched. Idempotent
-- (exclusion_reason IS NULL guard); re-running affects zero rows.
--
-- Apply with:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0174_exclude_reviewed_earned_income_stripe_deposits.sql

-- Before-state diagnostics: how many rows match the reviewed scope and are not
-- yet excluded. Retain this in the run log as the baseline.
SELECT count(*) AS reviewed_earned_income_rows_to_exclude
FROM staged_payments s
WHERE s.funding_source = 'stripe'
  AND s.qb_entity_type = 'deposit'
  AND s.exclusion_reason IS NULL
  AND s.line_account_names = ARRAY['4020 Services - Earned Income']::text[]
  AND EXISTS (
    SELECT 1
    FROM bank_deposits d
    JOIN bank_transactions bt ON bt.id = d.source_bank_transaction_id
    WHERE d.memo ~* 'stripe[[:space:]]+transfer'
      AND bt.qb_posting ~ 'Deposit: 4020'
      AND NOT EXISTS (
        SELECT 1 FROM stripe_payouts p WHERE p.bank_deposit_id = d.id
      )
      AND d.amount = (s.qb_raw->>'TotalAmt')::numeric
      AND d.deposit_date = COALESCE((s.qb_raw->>'TxnDate')::date, s.date_received)
  );

UPDATE staged_payments s
SET exclusion_reason = 'earned_income',
    classification_source = 'manual',
    updated_at = now()
WHERE s.funding_source = 'stripe'
  AND s.qb_entity_type = 'deposit'
  AND s.exclusion_reason IS NULL
  AND s.line_account_names = ARRAY['4020 Services - Earned Income']::text[]
  AND EXISTS (
    SELECT 1
    FROM bank_deposits d
    JOIN bank_transactions bt ON bt.id = d.source_bank_transaction_id
    WHERE d.memo ~* 'stripe[[:space:]]+transfer'
      AND bt.qb_posting ~ 'Deposit: 4020'
      AND NOT EXISTS (
        SELECT 1 FROM stripe_payouts p WHERE p.bank_deposit_id = d.id
      )
      AND d.amount = (s.qb_raw->>'TotalAmt')::numeric
      AND d.deposit_date = COALESCE((s.qb_raw->>'TxnDate')::date, s.date_received)
  );

-- After-state diagnostics: total earned-income exclusions now carrying the
-- manual pin, and remaining unexcluded rows in the reviewed scope (should be 0).
SELECT
  count(*) FILTER (
    WHERE exclusion_reason = 'earned_income'
      AND classification_source = 'manual'
      AND funding_source = 'stripe'
      AND qb_entity_type = 'deposit'
  ) AS manual_earned_income_stripe_deposits
FROM staged_payments;
