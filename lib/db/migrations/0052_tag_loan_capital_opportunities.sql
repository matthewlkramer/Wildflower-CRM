-- Migration 0052: Tag historical loan-fund deals as loan_capital
--
-- Migration 0051 added opportunities_and_pledges.fundraising_category with a
-- NON-DESTRUCTIVE default of 'revenue', so every pre-existing opportunity/pledge
-- was classified as revenue. As a result the dashboard's new Loan Capital track
-- renders empty even though Wildflower has real loan-fund (PRI / CDFI / program-
-- related-investment) activity. This file re-categorizes those historical deals
-- so the second track reflects actual money.
--
-- WHAT COUNTS AS LOAN CAPITAL (opportunities/pledges):
--   (a) Any allocation booked to the loan/debt fund entity ("Sunlight - debt",
--       slug `sunlight_debt`). This entity is, by definition, the loan-fund
--       (debt) pool — distinct from "Sunlight - grants" (revenue). Every opp
--       with a sunlight_debt allocation is a CDFI / PRI / loan / guarantee deal.
--   (b) Any opportunity/pledge that RECEIVES a loan_fund_investment payment
--       (gifts_and_payments.type = 'loan_fund_investment'). The money landing as
--       loan capital proves the commitment was loan capital. This catches loan
--       deals that were booked under a non-debt entity (e.g. SpringPoint PRI -
--       Emerging Hub Revolving Loan Fund, booked with no entity).
--   (c) An explicitly reviewed id list for clear loan deals (loan/PRI in the
--       name) that carry neither a sunlight_debt allocation nor a loan payment
--       yet. Kept as an explicit, human-reviewed list rather than a fuzzy name
--       match so a "CDFI grant" (revenue) is never swept up by accident:
--         recbMikoIQyPlZ0uR  — "CSGF HUB LOAN"
--
-- GIFTS / PAYMENTS need NO backfill: loan-capital gifts are DERIVED at query
-- time from gifts_and_payments.type = 'loan_fund_investment' (see analytics.ts
-- giftCategorySql). There is no fundraising_category column on gifts.
--
-- NON-DESTRUCTIVE + IDEMPOTENT:
--   - Only ever SETS fundraising_category = 'loan_capital'; never flips a row
--     back to 'revenue'. A human override to revenue is therefore preserved on
--     re-run (the WHERE excludes rows already loan_capital).
--   - Re-running is a no-op once tagged.
--   - Depends on 0051 having created the column (run 0051 first / Publish).
--
-- APPLY (dev already applied by the agent; prod is human-run):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0052_tag_loan_capital_opportunities.sql

-- Pre-state (for the operator).
DO $$
DECLARE n_before int;
BEGIN
  SELECT count(*) INTO n_before
    FROM opportunities_and_pledges WHERE fundraising_category = 'loan_capital';
  RAISE NOTICE '0052: loan_capital opps BEFORE = %', n_before;
END $$;

UPDATE opportunities_and_pledges op
SET fundraising_category = 'loan_capital',
    updated_at = now()
WHERE op.fundraising_category <> 'loan_capital'
  AND (
    -- (a) booked to the loan/debt fund entity
    EXISTS (
      SELECT 1 FROM pledge_allocations pa
      WHERE pa.pledge_or_opportunity_id = op.id
        AND pa.entity_id = 'sunlight_debt'
    )
    -- (b) receives a loan_fund_investment payment
    OR EXISTS (
      SELECT 1 FROM gifts_and_payments g
      WHERE g.payment_on_pledge_id = op.id
        AND g.type = 'loan_fund_investment'
    )
    -- (c) explicitly reviewed name-marker loans (no debt entity / loan payment)
    OR op.id IN ('recbMikoIQyPlZ0uR')
  );

-- Post-state (for the operator). Expect 23 on the seed dataset.
DO $$
DECLARE n_after int;
BEGIN
  SELECT count(*) INTO n_after
    FROM opportunities_and_pledges WHERE fundraising_category = 'loan_capital';
  RAISE NOTICE '0052: loan_capital opps AFTER = % (expect 23 on the seed dataset)', n_after;
END $$;
