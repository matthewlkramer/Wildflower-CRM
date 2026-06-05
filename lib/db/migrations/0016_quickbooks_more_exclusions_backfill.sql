-- Migration 0016: Backfill — apply the new auto-exclude reasons to the queue
--
-- Re-runs the refined noise classifier over the EXISTING QuickBooks review queue
-- for the four new/extended rules. Matching rows are marked status = 'excluded'
-- with the new exclusion_reason. NOTHING is deleted.
--
--   Part D  government_reimbursement — exact payer "CSP" (government program).
--   Part E  loan (guaranty fee)      — guaranty-revenue income account / item.
--   Part F  interest                 — "Interest Earned" account / "INTEREST" item.
--   Part G  tax_refund               — payroll-tax / tax / insurance refunds.
--
-- These mirror classifyStagedPayment() in quickbooksExclusionRules.ts EXACTLY:
--   * Part D is a payer-identity rule — definitive, no donation guard.
--   * Parts E/F/G are LINE-BASED and honor the DONATION-FIRST GUARD: a row that
--     also carries a real donation line (a 4000/4100-series donation account or
--     a "Donation" item) is left in 'pending', so a deposit that bundles a gift
--     with a fee / interest / refund line is never wrongly hidden.
--   * Account markers match by QuickBooks account-code PREFIX (lower+trim), items
--     by case-insensitive substring — identical to the classifier's normalize().
--
-- SAFETY / IDEMPOTENCY:
--   * Only ever touches rows whose status is currently 'pending'. Approved /
--     rejected / already-excluded rows are never modified, so prior decisions and
--     re-includes are preserved and re-running is a no-op.
--   * Order matters only for mutual exclusivity: each part excludes its rows, so
--     a later part won't re-touch them (it filters status = 'pending'). Part D
--     runs first so a CSP payment is labelled government_reimbursement even if it
--     also carries a guaranty/interest/tax line — matching the classifier order.
--
-- PREREQUISITES:
--   1. 0015_quickbooks_exclusion_reasons_enum.sql has COMMITTED (the new enum
--      values must exist before this transaction can use them).
--   2. The new app code is deployed AND a full re-pull has run (Settings →
--      QuickBooks → "Sync now", or the scheduler) so line_item_names /
--      line_account_names are populated — Parts E/F/G need line detail.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0016_quickbooks_more_exclusions_backfill.sql

BEGIN;

-- ─── Part D: government reimbursement — exact payer "CSP" (no guard) ────────
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'government_reimbursement',
       updated_at = now()
 WHERE status = 'pending'
   AND payer_name IS NOT NULL
   AND lower(btrim(payer_name)) = 'csp';

-- ─── Part E: guaranty fees = loan activity (line-based, donation-guarded) ───
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'loan',
       updated_at = now()
 WHERE status = 'pending'
   AND (
     EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
              WHERE lower(btrim(a)) LIKE '4102%')
     OR EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                 WHERE lower(btrim(li)) LIKE '%guaranty%')
   )
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                    WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                    WHERE lower(btrim(li)) LIKE '%donation%');

-- ─── Part F: interest income (line-based, donation-guarded) ─────────────────
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'interest',
       updated_at = now()
 WHERE status = 'pending'
   AND (
     EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
              WHERE lower(btrim(a)) LIKE '4010%')
     OR EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                 WHERE lower(btrim(li)) LIKE '%interest%')
   )
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                    WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                    WHERE lower(btrim(li)) LIKE '%donation%');

-- ─── Part G: tax / insurance refunds (line-based, donation-guarded) ─────────
-- Refunds post back to the expense account they came from: payroll taxes
-- (7010.4), taxes (7020), insurance (7006).
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'tax_refund',
       updated_at = now()
 WHERE status = 'pending'
   AND EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                WHERE lower(btrim(a)) LIKE '7010.4%'
                   OR lower(btrim(a)) LIKE '7020%'
                   OR lower(btrim(a)) LIKE '7006%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                    WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                    WHERE lower(btrim(li)) LIKE '%donation%');

-- Verification:
--   SELECT status, exclusion_reason, count(*)
--   FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;

COMMIT;
