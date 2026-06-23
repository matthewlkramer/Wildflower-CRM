-- Migration 0072: QuickBooks exclusion-reason reorg — rules + history backfill
--
-- Brings PRODUCTION DATA + the persisted handling-rule set in line with the
-- exclusion-reason reorganization (the SQL counterpart of the classifier rework
-- in quickbooksExclusionRules.ts and the seed in quickbooksRules.ts):
--
--   * The overloaded `loan` reason is SPLIT into loan_repayment / loan_proceeds /
--     note_payable, and guaranty activity is folded into `earned_income`.
--   * The broad `\bloans?\b` LINE/ACCOUNT match is RETIRED. Loan-FUND CAPITAL
--     (money INTO the revolving loan fund — a real gift posted to a contributions
--     account) was wrongly swept by it; such rows are RE-SURFACED to the queue.
--   * `government_reimbursement` STOPS being an exclusion: auto-excluded CSP rows
--     are re-surfaced to the queue and flagged counts_toward_goal = false so the
--     eventual gift mints non-goal.
--   * `fiscally_sponsored` was already retired by 0049 (entity attribution +
--     re-surface); nothing to do here for it.
--
-- PREREQUISITES:
--   1. 0071_quickbooks_exclusion_reorg_enum.sql has COMMITTED (new enum values
--      must exist before this transaction can write them).
--   2. The new app code is deployed and a full re-pull has populated line detail
--      (line_item_names / line_account_names) — the line-based re-code needs it.
--
-- ⚠️ LOCKSTEP — this is the SQL mirror of classifyStagedPayment() /
--    quickbooksExclusionRules.ts. Keep the regexes + account prefixes in sync:
--      * payer guaranty fee  TS /\bguaranty\s+fee\b/i      -> PG ~* '\mguaranty\s+fee\M'
--      * payer loan/repayment TS /\bloan\b/ /\brepayment\b/ -> PG ~* '\mloan\M' / '\mrepayment\M'
--      * note payable (line)  TS /notes? payable/i          -> PG ~* 'notes? payable'
--      * loan proceeds (line) TS /ppp loan|loan received|loan proceeds/i (same)
--      * loan repayment(line) TS /loans to schools|loan repayment|\brepayment\b/i
--                                                           -> PG ~* 'loans to schools|loan repayment|\mrepayment\M'
--      * guaranty (line)      account prefix '4102' OR item contains 'guaranty'
--      * donation guard       account prefix '4000'/'4100' OR item contains 'donation'
--    The classifier's loanLineHaystack joins raw_reference + line_description +
--    line_item_names + line_account_names with a space, then tests the regex
--    against that one string — the re-code below builds the same haystack.
--
-- IDEMPOTENCY / SAFETY:
--   * Re-code steps touch ONLY rows still status='excluded' AND the source reason,
--     AND classification_source='auto' — a human's manual exclude is never moved.
--   * Each step rewrites the reason away from 'loan', so a row is touched by the
--     FIRST matching step only — giving the same first-match-wins order as the
--     classifier. Re-running is a no-op.
--   * Rule changes are guarded on their current state; the new rule INSERTs use
--     ON CONFLICT (id) DO NOTHING. NOTHING is deleted.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0072_quickbooks_exclusion_reorg_backfill.sql

BEGIN;

-- ─── 0. Schema safety (idempotent) ─────────────────────────────────────────
-- counts_toward_goal reaches prod via the normal Publish (drizzle) diff; added
-- here too so this file is self-contained and safe to run before OR after Publish.
ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS counts_toward_goal boolean NOT NULL DEFAULT true;
ALTER TABLE gifts_and_payments
  ADD COLUMN IF NOT EXISTS counts_toward_goal boolean NOT NULL DEFAULT true;

-- ─── 1. Handling rules: retire the overloaded loan rules + gov-reimbursement,
--        fold guaranty into earned_income, add the precise new families. ──────

-- 1a. Disable the obsolete loan / government-reimbursement seed rules (guarded).
--     Kept (not deleted) so the change is reversible and any historical
--     matched_rule_id reference stays valid.
UPDATE quickbooks_handling_rules
   SET enabled = false, updated_at = now()
 WHERE id IN ('seed_loan_payer', 'seed_loan_line', 'seed_government_reimbursement')
   AND enabled = true;

-- 1b. Guaranty fees are EARNED INCOME, not loan activity: re-point the existing
--     line-based guaranty rule's reason (guarded on its old reason).
UPDATE quickbooks_handling_rules
   SET exclusion_reason = 'earned_income', updated_at = now()
 WHERE id = 'seed_guaranty'
   AND exclusion_reason = 'loan';

-- 1c. Add the precise replacement rules (exact mirror of SEED_RULES). New ids,
--     so ON CONFLICT DO NOTHING never clobbers an admin's later edits.
INSERT INTO quickbooks_handling_rules
  (id, name, enabled, priority, action, exclusion_reason, donation_guard, match_logic, conditions)
VALUES
  ('seed_guaranty_payer', 'Guaranty fee (payer) — earned income', true, 30, 'exclude', 'earned_income', false, 'any',
   '[{"field":"payer_name","mode":"regex","value":"\\bguaranty\\s+fee\\b"}]'::jsonb),

  ('seed_loan_repayment_payer', 'Loan repayment (payer)', true, 40, 'exclude', 'loan_repayment', false, 'any',
   '[{"field":"payer_name","mode":"regex","value":"\\bloan\\b"},
     {"field":"payer_name","mode":"regex","value":"\\brepayment\\b"}]'::jsonb),

  ('seed_note_payable_line', 'Note payable (line detail)', true, 90, 'exclude', 'note_payable', true, 'any',
   '[{"field":"memo_reference","mode":"regex","value":"notes? payable"},
     {"field":"line_description","mode":"regex","value":"notes? payable"},
     {"field":"line_item_name","mode":"regex","value":"notes? payable"},
     {"field":"line_account_name","mode":"regex","value":"notes? payable"}]'::jsonb),

  ('seed_loan_proceeds_line', 'Loan proceeds (line detail)', true, 92, 'exclude', 'loan_proceeds', true, 'any',
   '[{"field":"memo_reference","mode":"regex","value":"ppp loan|loan received|loan proceeds"},
     {"field":"line_description","mode":"regex","value":"ppp loan|loan received|loan proceeds"},
     {"field":"line_item_name","mode":"regex","value":"ppp loan|loan received|loan proceeds"},
     {"field":"line_account_name","mode":"regex","value":"ppp loan|loan received|loan proceeds"}]'::jsonb),

  ('seed_loan_repayment_line', 'Loan repayment (line detail)', true, 94, 'exclude', 'loan_repayment', true, 'any',
   '[{"field":"memo_reference","mode":"regex","value":"loans to schools|loan repayment|\\brepayment\\b"},
     {"field":"line_description","mode":"regex","value":"loans to schools|loan repayment|\\brepayment\\b"},
     {"field":"line_item_name","mode":"regex","value":"loans to schools|loan repayment|\\brepayment\\b"},
     {"field":"line_account_name","mode":"regex","value":"loans to schools|loan repayment|\\brepayment\\b"}]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ─── 2. Re-code historical `loan` exclusions into the new families. ──────────
-- Order mirrors the classifier (payer rules first, then line rules in
-- note_payable -> loan_proceeds -> loan_repayment_line -> guaranty_line order).
-- Each step filters exclusion_reason='loan', so a row is moved by the first match
-- only. The line steps honor the donation-first guard. Auto-classified rows only.

-- 2a. Guaranty fee by PAYER -> earned_income (payer-identity, no donation guard).
UPDATE staged_payments
   SET exclusion_reason = 'earned_income', updated_at = now()
 WHERE status = 'excluded'
   AND exclusion_reason = 'loan'
   AND classification_source = 'auto'
   AND payer_name IS NOT NULL
   AND payer_name ~* '\mguaranty\s+fee\M';

-- 2b. Loan repayment by PAYER -> loan_repayment (payer-identity, no guard).
UPDATE staged_payments
   SET exclusion_reason = 'loan_repayment', updated_at = now()
 WHERE status = 'excluded'
   AND exclusion_reason = 'loan'
   AND classification_source = 'auto'
   AND payer_name IS NOT NULL
   AND (payer_name ~* '\mloan\M' OR payer_name ~* '\mrepayment\M');

-- 2c. Note payable on the LINE -> note_payable (donation-guarded).
UPDATE staged_payments
   SET exclusion_reason = 'note_payable', updated_at = now()
 WHERE status = 'excluded'
   AND exclusion_reason = 'loan'
   AND classification_source = 'auto'
   AND concat_ws(' ', raw_reference, line_description,
         array_to_string(coalesce(line_item_names, '{}'::text[]), ' '),
         array_to_string(coalesce(line_account_names, '{}'::text[]), ' ')) ~* 'notes? payable'
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                    WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                    WHERE lower(btrim(li)) LIKE '%donation%');

-- 2d. Loan proceeds on the LINE -> loan_proceeds (donation-guarded). Before
--     loan_repayment so "PPP Loan Received" lands here.
UPDATE staged_payments
   SET exclusion_reason = 'loan_proceeds', updated_at = now()
 WHERE status = 'excluded'
   AND exclusion_reason = 'loan'
   AND classification_source = 'auto'
   AND concat_ws(' ', raw_reference, line_description,
         array_to_string(coalesce(line_item_names, '{}'::text[]), ' '),
         array_to_string(coalesce(line_account_names, '{}'::text[]), ' ')) ~* 'ppp loan|loan received|loan proceeds'
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                    WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                    WHERE lower(btrim(li)) LIKE '%donation%');

-- 2e. Loan repayment on the LINE -> loan_repayment (donation-guarded). NARROW by
--     design — loan-fund capital posted to a contributions account no longer
--     matches and is left for step 2g.
UPDATE staged_payments
   SET exclusion_reason = 'loan_repayment', updated_at = now()
 WHERE status = 'excluded'
   AND exclusion_reason = 'loan'
   AND classification_source = 'auto'
   AND concat_ws(' ', raw_reference, line_description,
         array_to_string(coalesce(line_item_names, '{}'::text[]), ' '),
         array_to_string(coalesce(line_account_names, '{}'::text[]), ' ')) ~* 'loans to schools|loan repayment|\mrepayment\M'
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                    WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                    WHERE lower(btrim(li)) LIKE '%donation%');

-- 2f. Guaranty fee on the LINE -> earned_income (donation-guarded): the 4102
--     guaranty-revenue account or a "guaranty" item.
UPDATE staged_payments
   SET exclusion_reason = 'earned_income', updated_at = now()
 WHERE status = 'excluded'
   AND exclusion_reason = 'loan'
   AND classification_source = 'auto'
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

-- 2g. RE-SURFACE the remainder: any auto `loan` row not matched above was swept
--     ONLY by the retired broad `\bloans?\b` match — this is the loan-FUND
--     CAPITAL (and any now-donation-bundled) money that must go back to the
--     queue. Status -> pending, reason cleared, rule detached.
UPDATE staged_payments
   SET status = 'pending',
       exclusion_reason = NULL,
       matched_rule_id = NULL,
       updated_at = now()
 WHERE status = 'excluded'
   AND exclusion_reason = 'loan'
   AND classification_source = 'auto';

-- ─── 3. Government reimbursement: stop excluding; flag non-goal. ─────────────
-- 3a. Re-surface rows auto-excluded as government_reimbursement back to the
--     queue (human exclusions are left untouched).
UPDATE staged_payments
   SET status = 'pending',
       exclusion_reason = NULL,
       matched_rule_id = NULL,
       updated_at = now()
 WHERE status = 'excluded'
   AND exclusion_reason = 'government_reimbursement'
   AND classification_source = 'auto';

-- 3b. Flag CSP-payer rows as non-goal so the gift a fundraiser records mints with
--     counts_toward_goal = false (mirror of isGovernmentReimbursement: payer "CSP").
UPDATE staged_payments
   SET counts_toward_goal = false, updated_at = now()
 WHERE payer_name IS NOT NULL
   AND lower(btrim(payer_name)) = 'csp'
   AND counts_toward_goal = true;

-- ─── Operator report (non-aborting) ─────────────────────────────────────────
DO $$
DECLARE
  n_loan_left int;
  n_repay int;
  n_proceeds int;
  n_note int;
  n_csp_nongoal int;
BEGIN
  SELECT count(*) INTO n_loan_left FROM staged_payments
   WHERE status = 'excluded' AND exclusion_reason = 'loan' AND classification_source = 'auto';
  SELECT count(*) INTO n_repay FROM staged_payments WHERE exclusion_reason = 'loan_repayment';
  SELECT count(*) INTO n_proceeds FROM staged_payments WHERE exclusion_reason = 'loan_proceeds';
  SELECT count(*) INTO n_note FROM staged_payments WHERE exclusion_reason = 'note_payable';
  SELECT count(*) INTO n_csp_nongoal FROM staged_payments
   WHERE lower(btrim(payer_name)) = 'csp' AND counts_toward_goal = false;
  RAISE NOTICE '0072: auto loan still excluded=% (expect 0), loan_repayment=%, loan_proceeds=%, note_payable=%, CSP non-goal=%',
    n_loan_left, n_repay, n_proceeds, n_note, n_csp_nongoal;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- OPTIONAL — physically drop the legacy enum values.
--
-- DO NOT run this as part of the rollout. The repo's documented FALLBACK keeps
-- `loan` / `government_reimbursement` / `fiscally_sponsored` as LEGACY enum
-- values: the classifier no longer emits them and the manual picker hides them,
-- but they remain valid so historical rows stay readable. PostgreSQL cannot
-- DROP an enum value, so removing them means recreating the type — only worth it
-- once EVERY row referencing a legacy value has been re-coded or archived.
--
-- Pre-flight (all must return 0 before attempting):
--   SELECT count(*) FROM staged_payments
--     WHERE exclusion_reason IN ('loan','government_reimbursement','fiscally_sponsored');
--   SELECT count(*) FROM quickbooks_handling_rules
--     WHERE exclusion_reason IN ('loan','government_reimbursement','fiscally_sponsored');
--
-- Recreation sketch (run by hand, reviewed, in its own migration):
--   BEGIN;
--   ALTER TYPE staged_payment_exclusion_reason RENAME TO staged_payment_exclusion_reason_old;
--   CREATE TYPE staged_payment_exclusion_reason AS ENUM (
--     'zero_amount','membership','interest','tax_refund','other_revenue','earned_income',
--     'insurance','expense_refund','expensify','returned_wire','loan_repayment',
--     'loan_proceeds','note_payable','miscoded_withdrawal','intercompany_transfer',
--     'other','processor_payout');
--   ALTER TABLE staged_payments ALTER COLUMN exclusion_reason TYPE staged_payment_exclusion_reason
--     USING exclusion_reason::text::staged_payment_exclusion_reason;
--   ALTER TABLE quickbooks_handling_rules ALTER COLUMN exclusion_reason TYPE staged_payment_exclusion_reason
--     USING exclusion_reason::text::staged_payment_exclusion_reason;
--   DROP TYPE staged_payment_exclusion_reason_old;
--   COMMIT;
-- ════════════════════════════════════════════════════════════════════════════
