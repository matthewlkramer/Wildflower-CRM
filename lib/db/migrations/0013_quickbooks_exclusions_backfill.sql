-- Migration 0013: Backfill — reclassify the existing QuickBooks review queue
--
-- Re-runs the noise classifier over rows that were staged BEFORE the
-- auto-exclude feature shipped (~3,000 in production). Matching rows are marked
-- status = 'excluded' with an exclusion_reason. NOTHING is deleted.
--
-- SAFETY / IDEMPOTENCY:
--   * Only ever touches rows whose status is currently 'pending'. Already
--     approved / rejected / excluded rows are never modified — so a fundraiser's
--     decisions and any prior re-include are preserved, and re-running is a no-op.
--   * Re-runnable: a second run finds nothing left in 'pending' that matches.
--
-- PREREQUISITE: 0012_quickbooks_exclusions_schema.sql must have COMMITTED first
-- (this file USES the 'excluded' enum value, which Postgres forbids in the same
-- transaction that added it).
--
-- ORDER OF THE THREE RULES:
--   Part A (zero_amount) and Part B (loan) run off fields that already exist on
--   every staged row, so they can run immediately.
--   Part C (membership) depends on the line-item detail captured by the NEW
--   pull (line_item_names / line_account_names). Existing rows have NULL there
--   until a read-only re-pull/sync enriches them (the sync's ON CONFLICT now
--   refreshes line detail for pending/excluded rows). RUN PART C ONLY AFTER:
--     1. the new app code is deployed, AND
--     2. a full re-pull has run (Settings → QuickBooks → "Sync now", or wait for
--        the scheduler) so line_item_names/line_account_names are populated, AND
--     3. the confirmed membership marker(s) have been filled into BOTH the
--        application config (quickbooksExclusionRules.ts) AND the array literals
--        in Part C below. See the runbook for the discovery query.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0013_quickbooks_exclusions_backfill.sql
--
-- (Parts A+B are safe to apply now; Part C is intentionally a no-op until its
-- marker arrays are filled in — empty arrays match nothing.)

BEGIN;

-- ─── Part A: zero / null amount ────────────────────────────────────────────
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'zero_amount',
       updated_at = now()
 WHERE status = 'pending'
   AND (amount IS NULL OR amount <= 0);

-- ─── Part B: loan activity (payer-name patterns, case-insensitive) ──────────
-- Mirrors LOAN_PAYER_PATTERNS in quickbooksExclusionRules.ts: word-boundary
-- "loan", "repayment", or "guaranty fee".
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'loan',
       updated_at = now()
 WHERE status = 'pending'
   AND payer_name IS NOT NULL
   AND (
     payer_name ~* '\yloan\y'
     OR payer_name ~* '\yrepayment\y'
     OR payer_name ~* '\yguaranty\s+fee\y'
   );

-- ─── Part C: membership (confirmed QB item / income-account marker) ─────────
-- CONFIRMED in production: member schools pay network membership dues under the
-- QuickBooks line item "School Contributions". These markers match
-- MEMBERSHIP_ITEM_NAMES / MEMBERSHIP_ACCOUNT_NAMES in quickbooksExclusionRules.ts.
-- Requires line detail to be populated first (run the full re-pull — 0014 +
-- "Sync now" — before this; rows with NULL line_item_names won't match).
-- Matching is case-insensitive + whitespace-trimmed to stay EXACTLY equivalent
-- to the classifier (normalize() = lower(trim(...)) in quickbooksExclusionRules.ts),
-- so the backfill can never miss a casing/spacing variant the live rule would
-- catch. Account markers are intentionally empty (membership is item-only).
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'membership',
       updated_at = now()
 WHERE status = 'pending'
   AND EXISTS (
     SELECT 1
       FROM unnest(coalesce(line_item_names, '{}'::text[])) AS li
      WHERE lower(btrim(li)) = ANY (ARRAY['school contributions'])
   );

-- Verification:
--   SELECT status, exclusion_reason, count(*)
--   FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;

COMMIT;
