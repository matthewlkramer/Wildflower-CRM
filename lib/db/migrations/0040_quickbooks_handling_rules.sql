-- Migration 0040: quickbooks_handling_rules — admin-editable QuickBooks
-- auto-handling rules + seed.
--
-- Moves the previously code-only "exclude as noise" classifier off the INGEST
-- path into an admin-editable, DB-backed rule list, and adds the first
-- `auto_create_approve` rule (AmazonSmile → mint a gift attributed to the donor
-- organization "Amazon / Amazon Foundation", allocate it to GenOps
-- (intended_usage = 'gen_ops'), match it, and land it in the auto/approved
-- queue). Rule edits affect only NEW incoming payments — queued rows are never
-- reclassified.
--
-- The seed reproduces today's `classifyStagedPayment` behavior EXACTLY (a vitest
-- fidelity test asserts `evaluateRules(SEED_RULES)` === `classifyStagedPayment`
-- over a representative fixture set). This file is the SQL mirror of SEED_RULES
-- in artifacts/api-server/src/lib/quickbooksRules.ts — keep the two in lockstep.
--
-- SCHEMA NOTE: the new enum (quickbooks_rule_action) and the
-- quickbooks_handling_rules table also reach production via the normal Publish
-- (drizzle) diff. They are (re)created here idempotently so this file is
-- self-contained and safe to run before OR after a Publish.
--
-- IDEMPOTENCY / SAFETY:
--   * Enum + table use IF NOT EXISTS / duplicate_object guards.
--   * Seed INSERTs use ON CONFLICT (id) DO NOTHING — re-running adds nothing and
--     never overwrites an admin's later edits.
--   * The AmazonSmile rule's target organization is resolved by NAME at apply
--     time; if the donor org is absent the rule is still seeded but DISABLED
--     (fail-safe: it can never mint a gift to a null donor — a fundraiser enables
--     it from the admin page once the org exists).
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0040_quickbooks_handling_rules.sql

BEGIN;

-- 1. Action enum (exclude | auto_create_approve).
DO $$ BEGIN
  CREATE TYPE quickbooks_rule_action AS ENUM ('exclude', 'auto_create_approve');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Table.
CREATE TABLE IF NOT EXISTS quickbooks_handling_rules (
  id                         TEXT                          PRIMARY KEY,
  name                       TEXT                          NOT NULL,
  enabled                    BOOLEAN                       NOT NULL DEFAULT true,
  priority                   INTEGER                       NOT NULL,
  action                     quickbooks_rule_action        NOT NULL,
  exclusion_reason           staged_payment_exclusion_reason,
  donation_guard             BOOLEAN                       NOT NULL DEFAULT false,
  match_logic                TEXT                          NOT NULL DEFAULT 'any',
  conditions                 JSONB                         NOT NULL DEFAULT '[]'::jsonb,
  target_organization_id     TEXT REFERENCES organizations (id),
  target_intended_usage      intended_usage,
  target_fundable_project_id TEXT REFERENCES fundable_projects (id),
  created_at                 TIMESTAMP                     NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMP                     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quickbooks_handling_rules_priority_idx
  ON quickbooks_handling_rules (priority);

-- 3. Seed — EXCLUDE rules (faithful mirror of classifyStagedPayment order).
INSERT INTO quickbooks_handling_rules
  (id, name, enabled, priority, action, exclusion_reason, donation_guard, match_logic, conditions)
VALUES
  ('seed_zero_amount', 'Zero / negative / missing amount', true, 10, 'exclude', 'zero_amount', false, 'any',
   '[{"field":"amount","mode":"lte","value":"0"}]'::jsonb),

  ('seed_loan_payer', 'Loan activity (payer name)', true, 30, 'exclude', 'loan', false, 'any',
   '[{"field":"payer_name","mode":"regex","value":"\\bloan\\b"},
     {"field":"payer_name","mode":"regex","value":"\\brepayment\\b"},
     {"field":"payer_name","mode":"regex","value":"\\bguaranty\\s+fee\\b"}]'::jsonb),

  ('seed_government_reimbursement', 'Government reimbursement (payer)', true, 40, 'exclude', 'government_reimbursement', false, 'any',
   '[{"field":"payer_name","mode":"exact","value":"CSP"}]'::jsonb),

  ('seed_fiscally_sponsored', 'Fiscally sponsored project', true, 50, 'exclude', 'fiscally_sponsored', false, 'any',
   '[{"field":"any_text","mode":"contains","value":"embracing equity"}]'::jsonb),

  ('seed_insurance', 'Insurance / COBRA reimbursement', true, 60, 'exclude', 'insurance', false, 'any',
   '[{"field":"any_text","mode":"contains","value":"cobra"}]'::jsonb),

  ('seed_expensify', 'Expensify reimbursement', true, 70, 'exclude', 'expensify', false, 'any',
   '[{"field":"any_text","mode":"contains","value":"expensify"}]'::jsonb),

  ('seed_returned_wire', 'Returned wire transfer', true, 80, 'exclude', 'returned_wire', false, 'any',
   '[{"field":"any_text","mode":"regex","value":"returned\\s+wire"}]'::jsonb),

  ('seed_loan_line', 'Loan activity (line detail)', true, 90, 'exclude', 'loan', true, 'any',
   '[{"field":"memo_reference","mode":"regex","value":"\\bloans?\\b|\\brepayment\\b"},
     {"field":"line_description","mode":"regex","value":"\\bloans?\\b|\\brepayment\\b"},
     {"field":"line_item_name","mode":"regex","value":"\\bloans?\\b|\\brepayment\\b"},
     {"field":"line_account_name","mode":"regex","value":"\\bloans?\\b|\\brepayment\\b"}]'::jsonb),

  ('seed_guaranty', 'Guaranty fee (loan activity)', true, 100, 'exclude', 'loan', true, 'any',
   '[{"field":"line_account_name","mode":"prefix","value":"4102"},
     {"field":"line_item_name","mode":"contains","value":"guaranty"}]'::jsonb),

  ('seed_interest', 'Interest / investment income', true, 110, 'exclude', 'interest', true, 'any',
   '[{"field":"line_account_name","mode":"prefix","value":"4010"},
     {"field":"line_account_name","mode":"prefix","value":"4040"},
     {"field":"line_account_name","mode":"contains","value":"realized gain/loss on investments"},
     {"field":"line_account_name","mode":"contains","value":"interest earned"},
     {"field":"line_item_name","mode":"contains","value":"interest"}]'::jsonb),

  ('seed_tax_refund', 'Tax / insurance refund', true, 120, 'exclude', 'tax_refund', true, 'any',
   '[{"field":"line_account_name","mode":"prefix","value":"7010.4"},
     {"field":"line_account_name","mode":"prefix","value":"7020"},
     {"field":"line_account_name","mode":"prefix","value":"7006"}]'::jsonb),

  ('seed_other_revenue_memo', 'Other-revenue non-gift (memo)', true, 130, 'exclude', 'other_revenue', true, 'all',
   '[{"field":"line_account_name","mode":"prefix","value":"4030"},
     {"field":"memo_reference","mode":"regex","value":"\\brewards?\\b|\\bbusiness checking\\b"}]'::jsonb),

  ('seed_other_revenue_desc', 'Other-revenue non-gift (line description)', true, 140, 'exclude', 'other_revenue', true, 'all',
   '[{"field":"line_account_name","mode":"prefix","value":"4030"},
     {"field":"line_description","mode":"regex","value":"\\brewards?\\b|\\bbusiness checking\\b"}]'::jsonb),

  ('seed_earned_income', 'Earned income (services)', true, 150, 'exclude', 'earned_income', true, 'any',
   '[{"field":"line_account_name","mode":"prefix","value":"4020"}]'::jsonb),

  ('seed_expense_refund', 'Expense refund', true, 160, 'exclude', 'expense_refund', false, 'any',
   '[{"field":"any_text","mode":"regex","value":"\\brefund"}]'::jsonb),

  ('seed_membership', 'Membership dues (School Contributions)', true, 170, 'exclude', 'membership', false, 'any',
   '[{"field":"line_item_name","mode":"exact","value":"School Contributions"}]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- 4. Seed — AmazonSmile AUTO-CREATE rule. Target donor resolved by name; the
-- rule is seeded DISABLED when the org is absent (fail-safe). intended_usage =
-- 'gen_ops' (GenOps is a usage category, NOT a fundable_projects row), so
-- target_fundable_project_id stays NULL.
INSERT INTO quickbooks_handling_rules
  (id, name, enabled, priority, action, donation_guard, match_logic, conditions,
   target_organization_id, target_intended_usage, target_fundable_project_id)
SELECT
  'seed_amazonsmile',
  'AmazonSmile (auto-create gift → GenOps)',
  (org.id IS NOT NULL),                  -- enabled only when the donor org exists
  20,
  'auto_create_approve',
  false,
  'any',
  '[{"field":"any_text","mode":"regex","value":"amazon\\s*smil"}]'::jsonb,
  org.id,
  'gen_ops',
  NULL
FROM (
  -- Always exactly one row; org.id is NULL when the donor org is absent so the
  -- rule is still seeded (disabled), never skipped entirely.
  SELECT (
    SELECT id
      FROM organizations
     WHERE lower(name) IN ('amazon / amazon foundation', 'amazon', 'amazon foundation')
     ORDER BY (lower(name) = 'amazon / amazon foundation') DESC
     LIMIT 1
  ) AS id
) AS org
ON CONFLICT (id) DO NOTHING;

COMMIT;
