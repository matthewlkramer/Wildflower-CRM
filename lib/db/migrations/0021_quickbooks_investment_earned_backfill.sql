-- Migration 0021: Backfill — investment income (4040) + earned income (4020)
--
-- Re-runs two refined rules over the EXISTING QuickBooks review queue. Matching
-- rows are marked status = 'excluded'. NOTHING is deleted.
--
-- This mirrors classifyStagedPayment() in quickbooksExclusionRules.ts EXACTLY:
--
--   A) interest (extended)  — the `interest` reason now also covers the
--      "Realized Gain/Loss on Investments" account (code PREFIX 4040), alongside
--      the existing "Interest Earned" (4010, already handled in 0016). These
--      4040 deposits carry an "Interest Earned" memo and are non-gift investment
--      income.
--   B) earned_income (new)  — rows coded to "Services - Earned Income" (code
--      PREFIX 4020): fees-for-service / program revenue, never a gift.
--
--   * Both are LINE-BASED rules — they honor the DONATION-FIRST GUARD: a row that
--     ALSO carries a real donation line (a 4000/4100-series donation account or a
--     "Donation" item) is left in 'pending', so a deposit that bundles a gift with
--     a 4040 / 4020 line is never wrongly hidden.
--   * Account markers match by account-code PREFIX (lower+trim) — identical to the
--     classifier's anyAccountCodeStartsWith().
--
-- RULE PRECEDENCE: the classifier evaluates interest BEFORE earned_income, so the
-- interest (4040) UPDATE runs first below; once those rows flip to 'excluded' they
-- drop out of the pending-only earned_income UPDATE — exactly mirroring first-
-- match-wins. (tax_refund / other_revenue, which also outrank earned_income, were
-- already applied in 0016 / 0019, so those rows are no longer pending.)
--
-- SAFETY / IDEMPOTENCY:
--   * Only ever touches rows whose status is currently 'pending'. Approved /
--     rejected / already-excluded rows are never modified, so prior decisions and
--     re-includes are preserved and re-running is a no-op.
--
-- PREREQUISITES:
--   1. 0020_quickbooks_earned_income_enum.sql has COMMITTED (the new enum value
--      must exist before this transaction can use it).
--   2. The new app code is deployed AND existing rows carry line detail
--      (line_account_names) — see the runbook re: a full historical re-pull for
--      rows that are missing line detail (they can't be classified by account).
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0021_quickbooks_investment_earned_backfill.sql

BEGIN;

-- ─── A) Investment income: Realized Gain/Loss on Investments (4040) → interest ───
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'interest',
       updated_at = now()
 WHERE status = 'pending'
   AND EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                WHERE lower(btrim(a)) LIKE '4040%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                    WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                    WHERE lower(btrim(li)) LIKE '%donation%');

-- ─── B) Earned income: Services - Earned Income (4020) → earned_income ───
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'earned_income',
       updated_at = now()
 WHERE status = 'pending'
   AND EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                WHERE lower(btrim(a)) LIKE '4020%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                    WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                    WHERE lower(btrim(li)) LIKE '%donation%');

-- Verification:
--   SELECT status, exclusion_reason, count(*)
--   FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;

COMMIT;
