-- Migration 0049: Finance Reconciliation — per-entity dimension on staged payments
--
-- Part of the "QuickBooks Review" → "Finance Reconciliation" rebrand. The app
-- now STOPS auto-excluding money that belongs to a fiscally sponsored Wildflower
-- entity (e.g. "Embracing Equity"). Instead each staged payment is ATTRIBUTED to
-- its entity (staged_payments.entity_id) and kept in the review queue, surfaced
-- via a new per-entity filter. The `fiscally_sponsored` exclusion concept is
-- retired (the enum VALUE is kept for historical rows).
--
-- This file brings PRODUCTION DATA in line with that code change. The schema
-- itself (staged_payments.entity_id + its index + FK) reaches production via the
-- normal Publish (drizzle) diff; this file only touches DATA + the one persisted
-- handling rule, and is safe to run before OR after a Publish.
--
-- WHAT IT DOES (all idempotent):
--   1. Seeds + activates the fiscally-sponsored entities that `detectEntity`
--      attributes to (Wildflower Foundation is the default/unattributed bucket).
--   2. DISABLES the legacy `seed_fiscally_sponsored` handling rule so new pulls
--      stop excluding "Embracing Equity" money (guarded — only the seed row, only
--      while it still carries the fiscally_sponsored reason).
--   3. RE-SURFACES rows the system auto-excluded as `fiscally_sponsored`
--      (status excluded → pending, reason → NULL) so they re-enter the queue.
--   4. BACKFILLS staged_payments.entity_id from the same ENTITY_MARKERS the app's
--      `detectEntity` uses — a faithful SQL mirror of that TypeScript classifier.
--
-- ⚠️ LOCKSTEP: step 4 is the SQL mirror of ENTITY_MARKERS / detectEntity in
--    artifacts/api-server/src/lib/quickbooksExclusionRules.ts. The TS scans, per
--    field, `value.toLowerCase().includes(marker)` over: payerName, rawReference,
--    lineDescription, lineClasses[], lineItemNames[], lineAccountNames[]. The SQL
--    below concatenates exactly those columns (arrays joined on a newline, which
--    no multi-word marker contains, so a marker can never falsely span two array
--    elements) and matches each marker with ILIKE '%marker%'. First marker that
--    matches in declaration order wins. Keep the two in sync.
--    "Sunlight" is intentionally NOT attributed — sunlight_debt / sunlight_grants
--    are one entity split across two rows that a bare "sunlight" marker can't
--    disambiguate, so those rows stay unattributed (Foundation default).
--
-- IDEMPOTENCY / SAFETY:
--   * Entity seed: ON CONFLICT (id) DO NOTHING (never overwrites an existing name).
--   * Activation / rule-disable / re-surface / backfill are all guarded so a
--     re-run is a no-op (each WHERE excludes rows already in the target state).
--   * The entity backfill only SETS entity_id when a marker matches; it never
--     clears an existing attribution (non-destructive), so it is safe to re-run.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0049_finance_reconciliation_entity_dimension.sql

BEGIN;

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

COMMIT;
