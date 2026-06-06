-- Migration 0030: Backfill — insurance (BASICCOBRA) + expense refunds ("refund")
--
-- Re-runs the new `insurance` and `expense_refund` rules over the EXISTING
-- QuickBooks review queue. Matching rows are marked status = 'excluded'.
-- NOTHING is deleted.
--
-- This mirrors classifyStagedPayment() in quickbooksExclusionRules.ts EXACTLY:
--   * Both are IDENTITY / TEXT rules — NO donation-first guard. They identify
--     money that is categorically not a gift regardless of how the line is coded.
--     This matters: some ERC tax refunds are MISCODED in QuickBooks to a 4000.4
--     donation income account, yet they are refunds, not contributions, so the
--     unguarded `expense_refund` rule still excludes them.
--   * insurance      — case-insensitive SUBSTRING 'basiccobra' anywhere on the
--                      row (payer, memo, line_description, Class, item, account).
--   * expense_refund — the word "refund" anywhere on the row, word-START anchored
--                      (POSIX `\m`, i.e. the classifier's /\brefund/i): matches
--                      "refund / refunds / refunded" but not "prefund".
--
-- RULE PRECEDENCE (first-match-wins, mirrored here by statement ORDER):
--   * `insurance` fires BEFORE the donation guard (right after fiscally_sponsored),
--     so its UPDATE runs first.
--   * `expense_refund` is the LAST text rule, AFTER the specific guarded rules
--     (interest / tax_refund / other_revenue / earned_income). Those guarded
--     rules were applied at insert time / by earlier backfills, so their rows are
--     no longer 'pending'; the pending-only filter here can't steal them and the
--     more specific `tax_refund` label is preserved for genuine tax/insurance
--     refunds. Only refund rows the guarded rules did NOT catch (wrong account,
--     or donation-coded like ERC) remain 'pending' and are caught here.
--
-- ⚠️ KEEP THIS IN LOCKSTEP WITH THE CLASSIFIER: the markers live in
-- INSURANCE_MARKER_SUBSTRINGS and EXPENSE_REFUND_TEXT_PATTERNS in
-- quickbooksExclusionRules.ts. If you change them there, change them here (or
-- just re-run the in-app reclassify).
--
-- SAFETY / IDEMPOTENCY:
--   * Only ever touches rows whose status is currently 'pending'. Approved /
--     rejected / already-excluded rows are NOT modified, so prior decisions and
--     re-includes are preserved and re-running is a no-op.
--   * ⚠️ A handful of BASICCOBRA rows were previously auto-excluded as
--     `tax_refund` (before the `insurance` reason existed). They are already out
--     of the queue, so this pending-only backfill leaves them under `tax_refund`.
--     Reclassify them by hand only if the precise label matters (see runbook).
--   * ⚠️ A couple of "refund" rows were already APPROVED into gifts before this
--     rule existed. They are NOT reclassified here (status <> 'pending') NOR by
--     the in-app reclassify (it skips approved rows). If they are actually expense
--     refunds, reject/unwind them per-row — see the runbook.
--
-- PREREQUISITES:
--   1. 0029_quickbooks_insurance_expense_refund_enum.sql has COMMITTED (the new
--      enum values must exist before this transaction can use them).
--   2. The new app code is deployed AND existing rows carry line detail
--      (line_description / line_account_names / line_item_names / line_classes).
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0030_quickbooks_insurance_expense_refund_backfill.sql

BEGIN;

-- ─── Insurance / COBRA reimbursements (BASICCOBRA marker) → insurance ───────
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'insurance',
       updated_at = now()
 WHERE status = 'pending'
   AND lower(concat_ws(' ',
         payer_name,
         raw_reference,
         line_description,
         array_to_string(coalesce(line_classes,       '{}'::text[]), ' '),
         array_to_string(coalesce(line_item_names,    '{}'::text[]), ' '),
         array_to_string(coalesce(line_account_names, '{}'::text[]), ' ')
       )) LIKE '%basiccobra%';

-- ─── Expense refunds (the word "refund") → expense_refund ───────────────────
-- Runs AFTER the insurance UPDATE; the pending-only filter preserves first-match
-- precedence. Unguarded by design (catches donation-miscoded ERC refunds).
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'expense_refund',
       updated_at = now()
 WHERE status = 'pending'
   AND lower(concat_ws(' ',
         payer_name,
         raw_reference,
         line_description,
         array_to_string(coalesce(line_classes,       '{}'::text[]), ' '),
         array_to_string(coalesce(line_item_names,    '{}'::text[]), ' '),
         array_to_string(coalesce(line_account_names, '{}'::text[]), ' ')
       )) ~ '\mrefund';

-- Verification:
--   SELECT status, exclusion_reason, count(*)
--   FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;

COMMIT;
