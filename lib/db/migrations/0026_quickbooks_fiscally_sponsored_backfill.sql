-- Migration 0026: Backfill — exclude fiscally sponsored project payments
--
-- Re-runs the `fiscally_sponsored` rule over the EXISTING QuickBooks review queue.
-- Matching rows are marked status = 'excluded', exclusion_reason =
-- 'fiscally_sponsored'. NOTHING is deleted.
--
-- This mirrors classifyStagedPayment() in quickbooksExclusionRules.ts EXACTLY:
--   * Project-IDENTITY rule — NO donation-first guard. A donation coded to the
--     other project is still the other project's money, so it is excluded even
--     when the row carries a 4000/4100 donation account or a "Donation" item.
--   * The marker is matched as a case-insensitive SUBSTRING anywhere on the row:
--     the QuickBooks Class (line_classes), payer_name, line item / account names,
--     line_description, or raw_reference — identical to the classifier's search.
--
-- ⚠️ KEEP THIS IN LOCKSTEP WITH THE CLASSIFIER: the marker list lives in
-- FISCALLY_SPONSORED_PROJECT_SUBSTRINGS in quickbooksExclusionRules.ts. Today it
-- is the single substring 'embracing equity'. If you add markers there, add the
-- matching OR-clauses here (or just re-run the in-app reclassify, below).
--
-- SAFETY / IDEMPOTENCY:
--   * Only ever touches rows whose status is currently 'pending'. Approved /
--     rejected / already-excluded rows are NOT modified, so prior decisions and
--     re-includes are preserved and re-running is a no-op.
--   * ⚠️ Embracing Equity payments that were ALREADY auto-matched/approved into a
--     gift before this rule existed are NOT reclassified by this file (it filters
--     status = 'pending') NOR by the in-app reclassify (it skips approved rows).
--     If any such rows exist, decide per-row whether to reject/unwind the gift —
--     see the runbook's "Already-approved rows" section.
--
-- PREREQUISITES:
--   1. 0025_quickbooks_fiscally_sponsored_enum.sql has COMMITTED (the new enum
--      value must exist before this transaction can use it).
--   2. The new app code is deployed AND a full re-pull has run (Settings →
--      QuickBooks → "Sync now", or the scheduler) so line_classes / line detail
--      are populated — the Class marker needs line detail.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0026_quickbooks_fiscally_sponsored_backfill.sql

BEGIN;

UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'fiscally_sponsored',
       updated_at = now()
 WHERE status = 'pending'
   AND (
        (payer_name       IS NOT NULL AND lower(payer_name)       LIKE '%embracing equity%')
     OR (raw_reference    IS NOT NULL AND lower(raw_reference)    LIKE '%embracing equity%')
     OR (line_description IS NOT NULL AND lower(line_description) LIKE '%embracing equity%')
     OR EXISTS (SELECT 1 FROM unnest(coalesce(line_classes,      '{}'::text[])) c
                 WHERE lower(c)  LIKE '%embracing equity%')
     OR EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names,   '{}'::text[])) li
                 WHERE lower(li) LIKE '%embracing equity%')
     OR EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names,'{}'::text[])) a
                 WHERE lower(a)  LIKE '%embracing equity%')
   );

-- Verification:
--   SELECT status, exclusion_reason, count(*)
--   FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;

COMMIT;
