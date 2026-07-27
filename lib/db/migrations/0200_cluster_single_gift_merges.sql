-- 0200: owner-ruled single-gift merges for the no-bank-match register
-- clusters (docs/rebuild/cluster_resolutions.csv, rulings 2026-07-23).
--
-- Five clusters where one physical payment was booked as two QBO lines and
-- entered the CRM as two gift records: merged into one gift, one payment
-- unit, with each QBO line keeping a qbo_line_allocation link and each
-- register row a qbo_register_unit link (no bank deposit exists for these —
-- they predate/escape the bank export coverage):
--
--   SGP $325,000 (9/6/2018)        = SGP FY19 $300k + SGP CBD FY19 $25k
--   Spring Point $100,000 (12/17/2019) = SPP FY20 $60k + SPP FY20 $40k (3 allocs)
--   Sep Kamvar $67,031.70 (2/26/2019)  = Sep NJ Gift (already both allocs)
--                                        absorbs "Gift for Corina's AMI training"
--                                        (30¢ book-vs-paid difference kept as booked)
--   Rogers $10,000 (1/6/2023)      = the two FY23 Rogers Foundation $5k gifts
--   Protouch $2,500 (1/5/2022)     = the two Protouch FY22 donations
--
-- Ruled non-gift and already excluded on their QBO lines (no action):
-- Cosmos ×2 (membership), Aster ×2 (loan_repayment). Misc Customer and the
-- Gerhardstein $400 cluster stay unresolved per owner.
--
-- Requires 0197 + 0198. Idempotent (guards on rows still existing).
--
-- Apply after Publish, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0200_cluster_single_gift_merges.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

------------------------------------------------------------------------------
-- 1. Allocation-grain provenance: each QBO line ties to the allocation(s) it
--    generated (written before the merge, while both units still exist).
------------------------------------------------------------------------------
INSERT INTO source_links (id, link_type, qb_staged_payment_id, gift_allocation_id, lifecycle, provenance, note)
SELECT 'srcl_qla_' || m.sp_id || '_' || m.alloc_id,
       'qbo_line_allocation', m.sp_id, m.alloc_id, 'confirmed', 'human',
       'cluster merge 0200: line booked at allocation grain'
FROM (VALUES
  -- SGP
  ('eYUufuwn1mea0hs80eKzK', 'synth-ga-recaKMBM7D9Bxv662'),   -- $300k
  ('3BKPGN7dLcb_pvliqNtRk', 'synth-ga-recuRLvecG7IgHgY6'),   -- $25k
  -- Spring Point (the $40k line was booked against three allocations)
  ('U0RvAAcm9VQ9VZbo_6EO_', 'recu8NmZp6sh9ofwi'),            -- $60k
  ('OnMpAecppoKLSZpyG-xfl', 'reclDSARHtaFn68Zk'),            -- $40k → $5k alloc
  ('OnMpAecppoKLSZpyG-xfl', 'ga0147-spp-fy20-gen-ops'),      -- $40k → $15k alloc
  ('OnMpAecppoKLSZpyG-xfl', 'ga0147-spp-fy20-phl-nj'),       -- $40k → $20k alloc
  -- Kamvar (survivor gift already carries both allocations)
  ('9reYKny4R5kcaNcVCZSLF', 'recnBiOMVtyJDeoft'),            -- $52,031.70 → $52,032 alloc
  ('AQnEFzVI3lH9f9Nlazhj3', 'recilrjIWVGN1YM7K'),            -- $15k
  -- Rogers
  ('ldeSy9n18PIOLd-YWRg5v', 'synth-ga-recVHlmEbTHnUWEe7'),   -- $5k
  ('LAB3xRJF2mjXNlACRgep7', 'synth-ga-recTBxNgsvNq8gxqA'),   -- $5k
  -- Protouch
  ('8t9TEpwP3r4J7Rmj6BRSV', 'synth-ga-rec0ZUefKu7KyOrSA'),   -- $1,500
  ('Jfv3d12_9LLbRf_XFMm4G', 'synth-ga-recDWdyYgnqWhGfUh')    -- $1,000
) AS m(sp_id, alloc_id)
WHERE EXISTS (SELECT 1 FROM staged_payments sp WHERE sp.id = m.sp_id)
  AND EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.id = m.alloc_id)
ON CONFLICT (qb_staged_payment_id, gift_allocation_id)
  WHERE link_type = 'qbo_line_allocation' DO NOTHING;

------------------------------------------------------------------------------
-- 2. Register-grain provenance: the cluster's QBO register rows tie to the
--    surviving (merged) payment unit.
------------------------------------------------------------------------------
INSERT INTO source_links (id, link_type, bank_transaction_id, payment_unit_id, lifecycle, provenance, match_basis, note)
SELECT 'srcl_qru_' || m.bnk_id,
       'qbo_register_unit', m.bnk_id, m.unit_id, 'confirmed', 'human', 'human',
       'cluster merge 0200: register rows of one physical payment'
FROM (VALUES
  ('bnk_00131128bdef8fd2c7bee604', 'pu_eYUufuwn1mea0hs80eKzK'),  -- SGP $300k
  ('bnk_2c81a4c08fe3508073012685', 'pu_eYUufuwn1mea0hs80eKzK'),  -- SGP $25k
  ('bnk_a3b7b81feee154af81d067af', 'pu_U0RvAAcm9VQ9VZbo_6EO_'),  -- SPP $40k
  ('bnk_f7bbc3e581bbd3e7fb4fda59', 'pu_U0RvAAcm9VQ9VZbo_6EO_'),  -- SPP $60k
  ('bnk_3261a0e0d5fcb854e868ecf2', 'pu_9reYKny4R5kcaNcVCZSLF'),  -- Kamvar $52,031.70
  ('bnk_86fe0fc84bc2ddd798ea04c6', 'pu_9reYKny4R5kcaNcVCZSLF'),  -- Kamvar $15k
  ('bnk_df86988bf22ad7a44387f2cf', 'pu_ldeSy9n18PIOLd-YWRg5v'),  -- Rogers $5k
  ('bnk_e04452ea208b755b89042fe3', 'pu_ldeSy9n18PIOLd-YWRg5v'),  -- Rogers $5k
  ('bnk_bb9e861bcff9a079bc138eb8', 'pu_8t9TEpwP3r4J7Rmj6BRSV'),  -- Protouch $1,000
  ('bnk_cf91b76f3739dd8329d1453f', 'pu_8t9TEpwP3r4J7Rmj6BRSV')   -- Protouch $1,500
) AS m(bnk_id, unit_id)
WHERE EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.id = m.bnk_id)
  AND EXISTS (SELECT 1 FROM payment_units pu WHERE pu.id = m.unit_id)
ON CONFLICT (id) DO NOTHING;

------------------------------------------------------------------------------
-- 3. Gift merges: allocations move to the survivor; the absorbed gift, its
--    unit, and its counted ledger row are removed; the survivor unit absorbs
--    the physical payment's full amount.
------------------------------------------------------------------------------
-- Allocations re-home (Kamvar's absorbed $15k allocation already exists on
-- the survivor as recilrjIWVGN1YM7K — the synthetic duplicate is deleted).
UPDATE gift_allocations ga SET gift_id = v.survivor, updated_at = now()
FROM (VALUES
  ('synth-ga-recuRLvecG7IgHgY6', 'recaKMBM7D9Bxv662'),
  ('reclDSARHtaFn68Zk',          'KYlJxI6LgdsPHitxwFxYa'),
  ('ga0147-spp-fy20-gen-ops',    'KYlJxI6LgdsPHitxwFxYa'),
  ('ga0147-spp-fy20-phl-nj',     'KYlJxI6LgdsPHitxwFxYa'),
  ('synth-ga-recTBxNgsvNq8gxqA', 'recVHlmEbTHnUWEe7'),
  ('synth-ga-recDWdyYgnqWhGfUh', 'rec0ZUefKu7KyOrSA')
) AS v(alloc_id, survivor)
WHERE ga.id = v.alloc_id AND ga.gift_id IS DISTINCT FROM v.survivor;

DELETE FROM gift_allocations
WHERE id = 'synth-ga-recC60zMGSevcjLgG' AND gift_id = 'recC60zMGSevcjLgG';

-- Absorbed units + their counted ledger rows go.
DELETE FROM payment_applications WHERE payment_unit_id IN
  ('pu_3BKPGN7dLcb_pvliqNtRk','pu_OnMpAecppoKLSZpyG-xfl','pu_AQnEFzVI3lH9f9Nlazhj3',
   'pu_LAB3xRJF2mjXNlACRgep7','pu_Jfv3d12_9LLbRf_XFMm4G');
DELETE FROM payment_units WHERE id IN
  ('pu_3BKPGN7dLcb_pvliqNtRk','pu_OnMpAecppoKLSZpyG-xfl','pu_AQnEFzVI3lH9f9Nlazhj3',
   'pu_LAB3xRJF2mjXNlACRgep7','pu_Jfv3d12_9LLbRf_XFMm4G');

DELETE FROM gifts_and_payments WHERE id IN
  ('recuRLvecG7IgHgY6','recaVJheMROdraT6f','recC60zMGSevcjLgG',
   'recTBxNgsvNq8gxqA','recDWdyYgnqWhGfUh');

-- Survivor gifts, units, and counted ledger rows take the merged amounts.
UPDATE gifts_and_payments g SET amount = v.amt, updated_at = now()
FROM (VALUES
  ('recaKMBM7D9Bxv662',     325000.00),
  ('KYlJxI6LgdsPHitxwFxYa', 100000.00),
  ('recVHlmEbTHnUWEe7',      10000.00),
  ('rec0ZUefKu7KyOrSA',       2500.00)
  -- Kamvar survivor recSN75zm6THORXLn stays $67,032 as booked (owner ruling)
) AS v(gift_id, amt)
WHERE g.id = v.gift_id AND g.amount IS DISTINCT FROM v.amt;

UPDATE payment_units pu SET gross_amount = v.amt, updated_at = now()
FROM (VALUES
  ('pu_eYUufuwn1mea0hs80eKzK', 325000.00),
  ('pu_U0RvAAcm9VQ9VZbo_6EO_', 100000.00),
  ('pu_9reYKny4R5kcaNcVCZSLF',  67031.70),
  ('pu_ldeSy9n18PIOLd-YWRg5v',  10000.00),
  ('pu_8t9TEpwP3r4J7Rmj6BRSV',   2500.00)
) AS v(unit_id, amt)
WHERE pu.id = v.unit_id AND pu.gross_amount IS DISTINCT FROM v.amt;

UPDATE payment_applications pa SET amount_applied = v.amt, updated_at = now()
FROM (VALUES
  ('pu_eYUufuwn1mea0hs80eKzK', 325000.00),
  ('pu_U0RvAAcm9VQ9VZbo_6EO_', 100000.00),
  ('pu_9reYKny4R5kcaNcVCZSLF',  67031.70),
  ('pu_ldeSy9n18PIOLd-YWRg5v',  10000.00),
  ('pu_8t9TEpwP3r4J7Rmj6BRSV',   2500.00)
) AS v(unit_id, amt)
WHERE pa.payment_unit_id = v.unit_id AND pa.link_role = 'counted'
  AND pa.amount_applied IS DISTINCT FROM v.amt;

------------------------------------------------------------------------------
-- 4. Post-conditions (fail loudly rather than commit a bad shape). Kamvar is
--    allowed its owner-accepted 30¢ book-vs-paid difference.
------------------------------------------------------------------------------
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM payment_applications pa
  JOIN payment_units pu ON pu.id = pa.payment_unit_id
  WHERE pa.link_role = 'counted' AND pu.gift_id IS DISTINCT FROM pa.gift_id;
  IF bad > 0 THEN RAISE EXCEPTION '0200: % counted ledger/pointer mismatches', bad; END IF;

  SELECT count(*) INTO bad FROM gifts_and_payments g
  JOIN LATERAL (
    SELECT COALESCE(sum(sub_amount), 0) s FROM gift_allocations ga WHERE ga.gift_id = g.id
  ) a ON true
  JOIN LATERAL (
    SELECT COALESCE(sum(gross_amount), 0) s FROM payment_units pu WHERE pu.gift_id = g.id
  ) u ON true
  WHERE g.id IN ('recaKMBM7D9Bxv662','KYlJxI6LgdsPHitxwFxYa','recSN75zm6THORXLn',
                 'recVHlmEbTHnUWEe7','rec0ZUefKu7KyOrSA')
    AND (a.s <> g.amount OR abs(u.s - g.amount) > 1.00);
  IF bad > 0 THEN RAISE EXCEPTION '0200: % merged gifts whose allocations/units do not sum to the gift amount', bad; END IF;
END $$;
