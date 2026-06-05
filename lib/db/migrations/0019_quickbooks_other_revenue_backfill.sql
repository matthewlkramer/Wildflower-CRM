-- Migration 0019: Backfill — apply the `other_revenue` rule to the queue
--
-- Re-runs the new Other-Revenue rule over the EXISTING QuickBooks review queue.
-- Matching rows are marked status = 'excluded', exclusion_reason =
-- 'other_revenue'. NOTHING is deleted.
--
-- This mirrors classifyStagedPayment() / isOtherRevenueNonGift() in
-- quickbooksExclusionRules.ts EXACTLY:
--   * The row is coded to the "Other Revenue" account (code PREFIX 4030), AND
--   * its memo (raw_reference) reads like a credit-card reward ("rewards"/
--     "reward") OR bank-account activity ("business checking").
--   * LINE-BASED + memo rule — honors the DONATION-FIRST GUARD: a row that also
--     carries a real donation line (a 4000/4100-series donation account or a
--     "Donation" item) is left in 'pending', so a deposit that bundles a gift
--     with a 4030 line is never wrongly hidden.
--   * Account markers match by account-code PREFIX (lower+trim); the memo match
--     uses case-insensitive word-boundary regex — identical to the classifier's
--     /\brewards?\b/i and /\bbusiness checking\b/i (normalize() lowercases/trims).
--
-- DELIBERATELY NARROW: only the two clear non-gift memos are caught. Everything
-- else coded to 4030 (legal settlements, refunds, unidentified deposits,
-- miscoded gifts) stays in 'pending' for a human to review — by design.
--
-- SAFETY / IDEMPOTENCY:
--   * Only ever touches rows whose status is currently 'pending'. Approved /
--     rejected / already-excluded rows are never modified, so prior decisions and
--     re-includes are preserved and re-running is a no-op.
--
-- PREREQUISITES:
--   1. 0018_quickbooks_other_revenue_enum.sql has COMMITTED (the new enum value
--      must exist before this transaction can use it).
--   2. The new app code is deployed AND existing rows carry line detail
--      (line_account_names) and memo (raw_reference) — see the runbook re: a full
--      historical re-pull if old rows are missing line detail.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0019_quickbooks_other_revenue_backfill.sql

BEGIN;

-- ─── Other-Revenue (4030) clear non-gifts (line + memo, donation-guarded) ───
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'other_revenue',
       updated_at = now()
 WHERE status = 'pending'
   AND raw_reference IS NOT NULL
   AND (
     raw_reference ~* '\yrewards?\y'
     OR raw_reference ~* '\ybusiness checking\y'
   )
   AND EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                WHERE lower(btrim(a)) LIKE '4030%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                    WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                    WHERE lower(btrim(li)) LIKE '%donation%');

-- Verification:
--   SELECT status, exclusion_reason, count(*)
--   FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;

COMMIT;
