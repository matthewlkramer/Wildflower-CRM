-- Migration 0031: Unwind 2 expense-refunds that were auto-matched into gifts
--
-- Two QuickBooks "refund" rows predate the expense_refund rule (0029/0030) and
-- were AUTO-MATCHED (status='approved', auto_applied=true, match_confirmed_at
-- NULL) to a PRE-EXISTING same-donor / same-amount / same-day gift. The 0030
-- pending-only backfill could not reach them (status <> 'pending'), nor can the
-- in-app reclassify (it skips approved rows). They are genuine expense refunds,
-- not contributions, so we un-reconcile and exclude them here.
--
--   1. NCMPS Wire Refund — $199,960.00, 2021-02-12 (acct "702 Grants to Schools",
--      an expense / grants-OUT account): a grant wire coming back.
--   2. "JH refunding personal charge on Divvy" — $41.86, 2025-11-26
--      (acct "7011 Office Supplies & Materials"): an employee repaying a personal
--      charge on the corporate card.
--
-- Both are linked via matched_gift_id (a PRE-EXISTING gift), NOT created_gift_id,
-- so clearing the pointer is safe: the gift row is untouched and never orphaned
-- (see stagedPayments.ts — unlinking is only allowed for matchedGiftId).
--
-- ⚠️ The two gifts they were tied to are NOT modified here. The refund amount
-- equals a same-day gift in both cases, which often signals a WASH (the original
-- deposit was later refunded). Those gifts are flagged for HUMAN review in the
-- runbook; this migration does not delete or alter them.
--
-- SAFETY / IDEMPOTENCY:
--   * Guarded to the exact auto-matched state (approved + auto_applied +
--     match_confirmed_at IS NULL + matched_gift_id set). If a human has since
--     confirmed or otherwise changed either row, the guard skips it — no clobber.
--   * After the first run the rows are 'excluded', so re-running is a no-op.
--   * classification_source = 'manual' pins the exclusion so the re-runnable
--     classifier / in-app reclassify never flips it back.
--   * Donor FKs and match_score/method are intentionally LEFT in place as an
--     audit trail of what the row had matched.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0031_quickbooks_unwind_approved_refunds.sql

BEGIN;

UPDATE staged_payments
   SET status                = 'excluded',
       exclusion_reason      = 'expense_refund',
       classification_source = 'manual',
       matched_gift_id       = NULL,
       auto_applied          = false,
       updated_at            = now()
 WHERE id IN (
         'sFmer7GdbGoYnQ2nnbsPB',  -- NCMPS Wire Refund, $199,960.00, 2021-02-12
         'KdOhRXgL4YGILOmjQdp5y'   -- JH refunding personal charge on Divvy, $41.86, 2025-11-26
       )
   AND status = 'approved'
   AND auto_applied = true
   AND match_confirmed_at IS NULL
   AND matched_gift_id IS NOT NULL;

-- Verification (expect 2 rows, both excluded / expense_refund / manual, no link):
--   SELECT id, status, exclusion_reason, classification_source,
--          matched_gift_id, auto_applied
--     FROM staged_payments
--    WHERE id IN ('sFmer7GdbGoYnQ2nnbsPB', 'KdOhRXgL4YGILOmjQdp5y');

COMMIT;
