-- Migration 0068: Backfill loan_or_grant from the legacy signals + Gary fix
--
-- PHASE 1 backfill for the authoritative loan_or_grant flag added by 0067.
-- Sets the flag to 'loan' for every row the legacy signals already classify as
-- loan, and applies the one data correction the team identified. Everything not
-- touched here stays at the 0067 default 'grant' (= all non-loan money).
--
--   A. opportunities_and_pledges  fundraising_category='loan_capital' -> loan
--   B. fiscal_year_entity_goals   category='loan_capital'             -> loan
--   C. gifts_and_payments         type='loan_fund_investment'         -> loan
--   D. DATA CORRECTION: Gary Community Investments $320,000 gift
--        recVwuwntn8Om8PTl (currently type=standard_gift) -> set BOTH
--        type='loan_fund_investment' AND loan_or_grant='loan' so the legacy
--        signal and the new flag agree (clean parity, intended delta = 0).
--        The separate $500 Gary gift is deliberately NOT touched (stays grant).
--
-- ORDERING: requires 0067 (the enum + columns) to have been applied first.
--
-- IDEMPOTENT / RE-RUNNABLE: every UPDATE is guarded so an already-correct row is
-- not rewritten (and re-running reports 0 rows affected). Running this AFTER live
-- dual-write has begun is safe -- it only ever promotes legacy-loan rows to
-- 'loan', never the reverse, and never touches a 'grant' row that has no legacy
-- loan signal.
--
-- NOTE (deliberately NOT done here): changing Gary's gift `type` does NOT
-- re-derive that gift's allocation revenue-coding snapshots (those are derived
-- in app code, not by a DB trigger). The "loan has no revenue account"
-- reconciliation is handled in the A002 read-cutover/parity phase.
--
-- Apply with psql -1 (wraps the file in ONE transaction; no top-level
-- BEGIN/COMMIT here):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0068_loan_or_grant_backfill.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0068_loan_or_grant_backfill.sql   (prod)

-- A. Opportunities / pledges -------------------------------------------------
UPDATE opportunities_and_pledges
   SET loan_or_grant = 'loan'
 WHERE fundraising_category = 'loan_capital'
   AND loan_or_grant <> 'loan';

-- B. Fiscal-year entity goals ------------------------------------------------
UPDATE fiscal_year_entity_goals
   SET loan_or_grant = 'loan'
 WHERE category = 'loan_capital'
   AND loan_or_grant <> 'loan';

-- C. Gifts already typed as loan-fund investment -----------------------------
UPDATE gifts_and_payments
   SET loan_or_grant = 'loan'
 WHERE type = 'loan_fund_investment'
   AND loan_or_grant <> 'loan';

-- D. DATA CORRECTION: Gary Community Investments $320,000 gift ---------------
--    Promote to a loan and align the legacy `type` so both signals agree.
UPDATE gifts_and_payments
   SET type = 'loan_fund_investment',
       loan_or_grant = 'loan'
 WHERE id = 'recVwuwntn8Om8PTl'
   AND (type IS DISTINCT FROM 'loan_fund_investment'
        OR loan_or_grant IS DISTINCT FROM 'loan');

-- Verification (expect zero mismatches between legacy signal and new flag):
--   SELECT count(*) AS opp_mismatch
--     FROM opportunities_and_pledges
--    WHERE (fundraising_category = 'loan_capital') <> (loan_or_grant = 'loan');
--   -- Expect 0.
--
--   SELECT count(*) AS goal_mismatch
--     FROM fiscal_year_entity_goals
--    WHERE (category = 'loan_capital') <> (loan_or_grant = 'loan');
--   -- Expect 0.
--
--   SELECT count(*) AS gift_mismatch
--     FROM gifts_and_payments
--    WHERE (type = 'loan_fund_investment') <> (loan_or_grant = 'loan');
--   -- Expect 0 (Gary's type was aligned in step D).
--
--   SELECT id, amount, type, loan_or_grant
--     FROM gifts_and_payments
--    WHERE id = 'recVwuwntn8Om8PTl';
--   -- Expect: amount 320000.00, type loan_fund_investment, loan_or_grant loan.
