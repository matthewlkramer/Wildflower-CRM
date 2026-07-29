-- 0217: fiscally-sponsored entity money is non-WF (owner ruling, 2026-07-23).
--
-- Money attributed to a fiscally sponsored entity (Embracing Equity, Tierra
-- Indígena, Rising Tide) belongs to the sponsored project, not Wildflower.
-- Owner ruled the whole row disappears from the workbench coherently:
--   1. Re-seed the ingest handling rule (`seed_fiscally_sponsored_non_wf`,
--      priority 50) so NEW fiscally-sponsored payments are excluded as non_wf
--      at sync (mirrors SEED_RULES in quickbooksRules.ts).
--   2. Relabel the existing fiscally-sponsored staged payments to non_wf
--      (fixing the earlier earned_income mislabels), pinning
--      classification_source = 'manual' so the ruling is durable (some rows
--      carry the entity only in qb_location, which the classifier cannot see,
--      so reclassify must never revisit them). zero_amount rows keep their
--      reason (classifier order: zero_amount fires first).
--   3. Mirror non_wf onto the bank_deposit_components composed from those
--      payments (the workbench's composition-plane exclusion).
--   4. Stamp a deposit-level non_wf exclusion (note naming the entity) on every
--      open deposit FULLY composed of fiscally-sponsored money, so the whole
--      row is excluded by explicit authority — never one hidden column with
--      dangling evidence in the others.
--
-- Gifts stay linked and keep their gift_allocations.entity_id attribution (the
-- gift-side record of whose money it was). Accounting evidence stays linked on
-- the excluded row.
--
-- DEPENDS ON 0216 (adds the non_wf enum value) — apply that first, autocommit.
-- This file is transactional:
--   lib/db/migrations/0217_fiscally_sponsored_non_wf.sql
--
-- Idempotent: the rule insert is ON CONFLICT DO NOTHING, the updates are
-- condition-guarded, and the deposit exclusions skip already-excluded deposits.

-- 1. Re-seed the ingest handling rule (the legacy seed_fiscally_sponsored rule
--    stays disabled; this one re-occupies priority 50 with reason non_wf).
INSERT INTO quickbooks_handling_rules
  (id, name, enabled, priority, action, exclusion_reason, donation_guard, match_logic, conditions)
VALUES
  ('seed_fiscally_sponsored_non_wf', 'Fiscally sponsored entity (non-WF money)', true, 50, 'exclude', 'non_wf', false, 'any',
   '[{"field":"any_text","mode":"contains","value":"embracing equity"},
     {"field":"any_text","mode":"contains","value":"tierra indígena"},
     {"field":"any_text","mode":"contains","value":"tierra indigena"},
     {"field":"any_text","mode":"contains","value":"rising tide"}]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Scope: staged payments attributed to a fiscally-sponsored entity, by
-- entity_id or by the QB location naming the sponsored project.
CREATE TEMP TABLE _fs_payments ON COMMIT DROP AS
SELECT sp.id,
       COALESCE(sp.entity_id,
                CASE
                  WHEN sp.qb_location ILIKE '%embracing equity%' THEN 'embracing_equity'
                  WHEN sp.qb_location ILIKE '%tierra ind%' THEN 'tierra_indigena'
                  WHEN sp.qb_location ILIKE '%rising tide%' THEN 'rising_tide'
                END) AS fs_entity_id
FROM staged_payments sp
WHERE sp.entity_id IN ('embracing_equity', 'tierra_indigena', 'rising_tide')
   OR sp.qb_location ILIKE '%embracing equity%'
   OR sp.qb_location ILIKE '%tierra ind%'
   OR sp.qb_location ILIKE '%rising tide%';

-- 2. Relabel the payments to non_wf (owner ruling → classification pinned).
UPDATE staged_payments sp
SET exclusion_reason = 'non_wf',
    classification_source = 'manual',
    updated_at = now()
FROM _fs_payments fs
WHERE sp.id = fs.id
  AND sp.exclusion_reason IS DISTINCT FROM 'zero_amount'
  AND sp.exclusion_reason IS DISTINCT FROM 'non_wf';

-- 3. Mirror onto the composition plane.
UPDATE bank_deposit_components c
SET exclusion_reason = 'non_wf',
    updated_at = now()
FROM payment_units u
JOIN _fs_payments fs ON fs.id = u.source_staged_payment_id
WHERE c.payment_unit_id = u.id
  AND c.exclusion_reason IS NULL;

-- 4. Deposit-level non_wf exclusions for open deposits FULLY composed of
--    fiscally-sponsored money (every component and every QBO deposit line is
--    in scope; no Stripe payout involvement).
INSERT INTO bank_deposit_exclusions (id, bank_deposit_id, reason, note, created_by_user_id)
SELECT 'bdex_' || d.id, d.id, 'non_wf'::staged_payment_exclusion_reason,
       'owner ruling (2026-07-23): fiscally sponsored entity money — ' ||
         (SELECT string_agg(DISTINCT fs2.fs_entity_id, ', ')
          FROM (
            SELECT fs.fs_entity_id
            FROM bank_deposit_components c
            JOIN payment_units u ON u.id = c.payment_unit_id
            JOIN _fs_payments fs ON fs.id = u.source_staged_payment_id
            WHERE c.bank_deposit_id = d.id
            UNION ALL
            SELECT fs.fs_entity_id
            FROM source_links sl
            JOIN _fs_payments fs ON fs.id = sl.qb_staged_payment_id
            WHERE sl.link_type = 'qbo_line_deposit' AND sl.bank_deposit_id = d.id
          ) fs2),
       'usr_matthew_kramer'
FROM bank_deposits d
WHERE NOT EXISTS (SELECT 1 FROM bank_deposit_exclusions bde WHERE bde.bank_deposit_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM stripe_payouts p WHERE p.bank_deposit_id = d.id)
  -- has fiscally-sponsored evidence…
  AND EXISTS (
    SELECT 1 FROM bank_deposit_components c
    JOIN payment_units u ON u.id = c.payment_unit_id
    JOIN _fs_payments fs ON fs.id = u.source_staged_payment_id
    WHERE c.bank_deposit_id = d.id
    UNION ALL
    SELECT 1 FROM source_links sl
    JOIN _fs_payments fs ON fs.id = sl.qb_staged_payment_id
    WHERE sl.link_type = 'qbo_line_deposit' AND sl.bank_deposit_id = d.id
  )
  -- …and NO non-fiscally-sponsored evidence.
  AND NOT EXISTS (
    SELECT 1 FROM bank_deposit_components c
    JOIN payment_units u ON u.id = c.payment_unit_id
    WHERE c.bank_deposit_id = d.id
      AND (u.source_staged_payment_id IS NULL
           OR NOT EXISTS (SELECT 1 FROM _fs_payments fs WHERE fs.id = u.source_staged_payment_id))
    UNION ALL
    SELECT 1 FROM source_links sl
    WHERE sl.link_type = 'qbo_line_deposit' AND sl.bank_deposit_id = d.id
      AND NOT EXISTS (SELECT 1 FROM _fs_payments fs WHERE fs.id = sl.qb_staged_payment_id)
  );

DO $$
DECLARE
  n_payments integer;
  n_components integer;
  n_deposits integer;
BEGIN
  SELECT count(*) INTO n_payments FROM staged_payments sp JOIN _fs_payments fs ON fs.id = sp.id WHERE sp.exclusion_reason = 'non_wf';
  SELECT count(*) INTO n_components FROM bank_deposit_components c JOIN payment_units u ON u.id = c.payment_unit_id JOIN _fs_payments fs ON fs.id = u.source_staged_payment_id WHERE c.exclusion_reason = 'non_wf';
  SELECT count(*) INTO n_deposits FROM bank_deposit_exclusions WHERE reason = 'non_wf' AND note LIKE 'owner ruling (2026-07-23): fiscally sponsored%';
  RAISE NOTICE '0217: staged payments non_wf=%, components non_wf=%, deposit exclusions=% (expect ~32)', n_payments, n_components, n_deposits;
END $$;
