-- Migration 0028: Backfill — interest / investment income matched by ACCOUNT NAME
--
-- Re-runs the refined `interest` rule over the EXISTING QuickBooks review queue.
-- Matching rows are marked status = 'excluded'. NOTHING is deleted.
--
-- WHY THIS EXISTS:
--   The `interest` rule (0016 + 0021) matches the income accounts by their QB
--   account-code PREFIX ("4010%" Interest Earned, "4040%" Realized Gain/Loss on
--   Investments). But QuickBooks sometimes emits those accounts by their human
--   NAME with NO leading code (e.g. "Realized Gain/Loss on Investments",
--   "Interest Earned"). Those rows slipped past the prefix match and stayed
--   'pending' in the queue. The classifier now ALSO matches the interest family
--   by account-NAME substring (INTEREST_ACCOUNT_NAME_SUBSTRINGS in
--   quickbooksExclusionRules.ts); this backfill mirrors that for existing rows.
--
-- This mirrors classifyStagedPayment() in quickbooksExclusionRules.ts EXACTLY:
--   * LINE-BASED rule — honors the DONATION-FIRST GUARD: a row that ALSO carries
--     a real donation line (a 4000/4100-series donation account or a "Donation"
--     item) is left 'pending', so a deposit bundling a gift with a gain/loss line
--     is never wrongly hidden.
--   * Account NAME match is a case-insensitive SUBSTRING (lower+btrim, LIKE
--     '%...%') — identical to the classifier's anyIncludes() over
--     INTEREST_ACCOUNT_NAME_SUBSTRINGS. (The code-prefix variants "4040 ..." /
--     "4010 ..." already contain these substrings, but they were excluded by
--     0016/0021 and are no longer 'pending', so the pending-only guard makes this
--     a no-op for them — only the code-LESS rows are newly caught.)
--
-- RULE PRECEDENCE: higher-precedence rules (loan / government_reimbursement /
-- fiscally_sponsored / guaranty) were already applied in earlier migrations, so
-- their rows are no longer 'pending'; a pending-only interest update can't steal
-- them. First-match-wins is preserved.
--
-- SAFETY / IDEMPOTENCY:
--   * Only ever touches rows whose status is currently 'pending'. Approved /
--     rejected / already-excluded rows are never modified, so prior decisions and
--     re-includes are preserved and re-running is a no-op.
--   * Reuses the existing 'interest' exclusion_reason — no enum change.
--
-- PREREQUISITES:
--   1. The new app code (account-NAME interest matching) is deployed.
--   2. Existing rows carry line detail (line_account_names). Rows missing line
--      detail can't be classified by account — see the watermark note in the
--      0020-0021 runbook if the back-catalog needs a full re-pull first.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0028_quickbooks_interest_by_name_backfill.sql

BEGIN;

-- ─── Interest / investment income by ACCOUNT NAME (code-less) → interest ───
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'interest',
       updated_at = now()
 WHERE status = 'pending'
   AND EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                WHERE lower(btrim(a)) LIKE '%realized gain/loss on investments%'
                   OR lower(btrim(a)) LIKE '%interest earned%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                    WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                    WHERE lower(btrim(li)) LIKE '%donation%');

-- Verification:
--   SELECT status, exclusion_reason, count(*)
--   FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;

COMMIT;
