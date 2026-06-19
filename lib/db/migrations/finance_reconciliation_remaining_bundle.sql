-- ════════════════════════════════════════════════════════════════════════════
-- Finance Reconciliation cutover — REMAINING data/schema (0049 + 0050 ×2)
--
-- One-shot bundle of the three files still outstanding after 0051 + 0052 were
-- applied. Combines, in order:
--   0049_finance_reconciliation_entity_dimension.sql  (DATA: re-surface + entity_id)
--   0050_revenue_coding_capture.sql                   (DATA: revenue accounts + restriction_type)
--   0050_staged_payment_entity_source.sql             (SCHEMA: entity_source enum/column)
--
-- All three are idempotent — a re-run is a no-op. This file has NO inner
-- BEGIN/COMMIT: the -1 flag wraps the whole bundle in ONE all-or-nothing
-- transaction. Apply with:
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/finance_reconciliation_remaining_bundle.sql
--
-- Prereq: the schema diff for these features must already be PUBLISHED — the data
-- ops below assume staged_payments.entity_id, revenue_accounts, entity_coding_rules,
-- and the *_allocations.restriction_type columns already exist.
-- ════════════════════════════════════════════════════════════════════════════


-- ═══ 0049: Finance Reconciliation — per-entity dimension on staged payments ═══
-- See 0049_..._RUNBOOK.md. ⚠️ Step 4 is the SQL mirror of ENTITY_MARKERS /
-- detectEntity in artifacts/api-server/src/lib/quickbooksExclusionRules.ts —
-- keep the two in lockstep. "Sunlight" is intentionally NOT attributed.

-- 1. Entities. Ensure the Foundation (default bucket) and every fiscally
--    sponsored entity that detectEntity attributes to exist and are active.
INSERT INTO entities (id, name, active) VALUES
  ('wildflower_foundation',    'Wildflower Foundation',                                  true),
  ('embracing_equity',         'Embracing Equity',                                       true),
  ('black_wildflowers_fund',   'Black Wildflowers Fund',                                 true),
  ('tierra_indigena',          'Tierra Indígena',                                        true),
  ('observation_support_tech', 'Observation Support Technologies / Observant Education', true),
  ('rising_tide',              'Rising Tide',                                            true)
ON CONFLICT (id) DO NOTHING;

-- Activate any that already existed but were marked inactive — they now legitimately
-- receive attributed money and must be visible as reconciliation targets.
UPDATE entities
   SET active = true, updated_at = now()
 WHERE id IN (
         'embracing_equity', 'black_wildflowers_fund', 'tierra_indigena',
         'observation_support_tech', 'rising_tide'
       )
   AND active = false;

-- 2. Disable the legacy fiscally_sponsored handling rule (guarded). New QuickBooks
--    pulls will stop excluding "Embracing Equity" money. Kept (not deleted) so the
--    change is reversible and any historical matched_rule_id reference stays valid.
UPDATE quickbooks_handling_rules
   SET enabled = false, updated_at = now()
 WHERE id = 'seed_fiscally_sponsored'
   AND exclusion_reason = 'fiscally_sponsored'
   AND enabled = true;

-- 3. Re-surface rows the system auto-excluded as fiscally_sponsored: back to the
--    review queue (pending), reason cleared, and detach the now-disabled rule.
--    Only auto-classified rows (classification_source = 'auto') — a human's manual
--    exclusion with this reason is left untouched.
UPDATE staged_payments
   SET status           = 'pending',
       exclusion_reason = NULL,
       matched_rule_id  = NULL,
       updated_at       = now()
 WHERE status                = 'excluded'
   AND exclusion_reason      = 'fiscally_sponsored'
   AND classification_source = 'auto';

-- 4. Backfill entity_id from ENTITY_MARKERS (faithful mirror of detectEntity).
--    Only sets entity_id when a marker matches — never clears an attribution.
WITH detected AS (
  SELECT id,
    CASE
      WHEN hay ILIKE '%embracing equity%'                               THEN 'embracing_equity'
      WHEN hay ILIKE '%black wildflower%'                               THEN 'black_wildflowers_fund'
      WHEN hay ILIKE '%tierra indígena%' OR hay ILIKE '%tierra indigena%' THEN 'tierra_indigena'
      WHEN hay ILIKE '%observant education%' OR hay ILIKE '%observation support%' THEN 'observation_support_tech'
      WHEN hay ILIKE '%rising tide%'                                    THEN 'rising_tide'
      ELSE NULL
    END AS entity_id
  FROM (
    SELECT id,
           concat_ws(E'\n',
             payer_name,
             raw_reference,
             line_description,
             array_to_string(line_classes, E'\n'),
             array_to_string(line_item_names, E'\n'),
             array_to_string(line_account_names, E'\n')
           ) AS hay
      FROM staged_payments
  ) s
)
UPDATE staged_payments p
   SET entity_id = d.entity_id, updated_at = now()
  FROM detected d
 WHERE p.id = d.id
   AND d.entity_id IS NOT NULL
   AND p.entity_id IS DISTINCT FROM d.entity_id;

-- Report post-state for the operator (non-aborting).
DO $$
DECLARE
  n_rule_disabled int;
  n_remaining_auto_fs int;
  n_attributed int;
BEGIN
  SELECT count(*) INTO n_rule_disabled
    FROM quickbooks_handling_rules
   WHERE id = 'seed_fiscally_sponsored' AND enabled = false;
  SELECT count(*) INTO n_remaining_auto_fs
    FROM staged_payments
   WHERE status = 'excluded'
     AND exclusion_reason = 'fiscally_sponsored'
     AND classification_source = 'auto';
  SELECT count(*) INTO n_attributed
    FROM staged_payments WHERE entity_id IS NOT NULL;
  RAISE NOTICE '0049: seed_fiscally_sponsored disabled=% (expect 1), auto fiscally_sponsored still excluded=% (expect 0), staged rows with entity_id=%',
    n_rule_disabled, n_remaining_auto_fs, n_attributed;
END $$;


-- ═══ 0050a: Revenue-coding capture (CFO "Revenue Extractor") ═══════════════════
-- Backfill rule (conservative): a restriction boolean set → 'purpose';
-- none set → 'unclear' (NEVER silently 'unrestricted'). Existing values untouched.

-- 1. Seed the closed Revenue Account list.
INSERT INTO revenue_accounts (code, name, kind, payer_type, sort_order, active)
VALUES
  ('4000.1', 'Unrestricted Donations - Individual',   'unrestricted', 'individual',   10,  true),
  ('4000.2', 'Unrestricted Donations - Foundation',   'unrestricted', 'foundation',   20,  true),
  ('4000.3', 'Unrestricted Donations - Corporation',  'unrestricted', 'corporation',  30,  true),
  ('4000.4', 'Unrestricted Donations - Governmental', 'unrestricted', 'governmental', 40,  true),
  ('4010',   'Interest Earned',                        'special',      NULL,           50,  true),
  ('4020',   'Services - Earned Income',               'special',      NULL,           60,  true),
  ('4099',   'Uncategorized Revenue',                  'special',      NULL,           70,  true),
  ('4100.1', 'Restricted Donations - Individual',      'restricted',   'individual',   80,  true),
  ('4100.2', 'Restricted Donations - Foundation',      'restricted',   'foundation',   90,  true),
  ('4100.3', 'Restricted Donations - Corporation',     'restricted',   'corporation',  100, true),
  ('4100.4', 'Restricted Donations - Governmental',    'restricted',   'governmental', 110, true),
  ('4102',   'Guaranty Revenue',                       'special',      NULL,           120, true),
  ('4300',   'Intercompany Donation Allocation',       'special',      NULL,           130, true),
  ('4500',   'Loan Fund Servicing',                    'special',      NULL,           140, true)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      kind = EXCLUDED.kind,
      payer_type = EXCLUDED.payer_type,
      sort_order = EXCLUDED.sort_order,
      updated_at = now();

-- 2. Seed per-entity coding rules (only for entities that exist).
-- Fiscal sponsees are always purpose-restricted; loan entities route to Loans.
INSERT INTO entity_coding_rules (entity_id, force_restricted, location, revenue_class, enabled, notes)
SELECT v.entity_id, v.force_restricted, v.location, v.revenue_class, v.enabled, v.notes
FROM (VALUES
  ('black_wildflowers_fund', true,  'Spo- Black Wildflowers Fund', 'General Operations'::text, true,
     'Fiscal sponsee — always purpose-restricted to BWF; class General Operations.'),
  ('tierra_indigena',        true,  'Spo- Tierra Indígena',        NULL::text,                 true,
     'Fiscal sponsee — always purpose-restricted to Tierra Indígena; no class.'),
  ('sunlight_debt',          false, 'Loans',                       NULL::text,                 true,
     'Loan-fund entity — routes to Loans location.'),
  ('sunlight_grants',        false, 'Loans',                       NULL::text,                 true,
     'Loan-fund entity — routes to Loans location.')
) AS v(entity_id, force_restricted, location, revenue_class, enabled, notes)
WHERE EXISTS (SELECT 1 FROM entities en WHERE en.id = v.entity_id)
ON CONFLICT (entity_id) DO NOTHING;

-- 3. Backfill restriction_type on gift_allocations.
UPDATE gift_allocations
SET restriction_type =
  CASE
    WHEN formal_fund_use_restriction OR formal_regional_restriction THEN 'purpose'::restriction_type
    ELSE 'unclear'::restriction_type
  END
WHERE restriction_type IS NULL;

-- 4. Backfill restriction_type on pledge_allocations.
UPDATE pledge_allocations
SET restriction_type =
  CASE
    WHEN formally_restricted THEN 'purpose'::restriction_type
    ELSE 'unclear'::restriction_type
  END
WHERE restriction_type IS NULL;


-- ═══ 0050b: Finance Reconciliation — manual entity-attribution override ════════
-- Adds the entity_source enum + column (orthogonal to classification_source).
-- entity_source = 'manual' means a human pinned the entity; detectEntity then
-- never clobbers it. Guarded / idempotent; existing rows default to 'auto'.

-- Entity-source enum (guarded — CREATE TYPE has no IF NOT EXISTS).
DO $$ BEGIN
  CREATE TYPE staged_payment_entity_source AS ENUM ('auto', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS entity_source staged_payment_entity_source
    NOT NULL DEFAULT 'auto';
