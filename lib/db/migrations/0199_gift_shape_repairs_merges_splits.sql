-- 0199: owner-ruled gift shape repairs — 8 over-split payment merges,
-- 5 multi-installment gift splits, 1 gift-record merge (Walton FY19).
--
-- Rulings (registry: docs/rebuild/cluster_resolutions.csv + session review,
-- bank-deposit cross-checked): a QBO booking that split ONE physical payment
-- into several allocation-grain lines must be ONE payment_unit → one gift →
-- N gift_allocations, with each QBO line keeping an allocation-grain
-- source_link (qbo_line_allocation) to the allocation it generated.
-- Conversely, a gift funded by several PHYSICAL payments (own bank deposit
-- each) becomes one gift record per installment.
--
-- MERGES (one bank deposit equals the lines' sum — verified):
--   Fidelity $80k (deposit 12/30/2025), WFF FY20 $850k (9/23/2019),
--   Walton FY20 National $3M (8/5/2019), Wend FY21 July $1M (9/4/2020),
--   Wend FY21 2nd $1M (2/1/2021), Wend FY22 $750k (8/10/2021),
--   Wend FY22 Part 2 $750k (1/31/2022), WFF FY21's $800k wire (7/30/2020),
--   Walton FY19 drawdown: ONE $325,000 wire booked as 8 × $40,625 lines that
--   were split across TWO gift records — merged into one gift, 8 lines.
--
-- SPLITS (each unit has its own bank deposit — verified):
--   Walton FY18 National $720k → $600k (8/21/2017) + $120k (1/19/2018)
--     (the $200k fy2018 allocation divides $140k/$60k across them),
--   Spring Point FY21 $1.35M → $1M (10/9/2020) + $350k (12/21/2020),
--   WFF FY19 $675k → $475k (12/7/2018) + $200k (4/1/2019),
--   Peretsman NYC FY20 $100k → $95,326.02 (12/11/2019) + $4,673.98 (12/20/2019),
--   WFF FY21 $917k → $117k (5/20/2020) + $800k (7/30/2020).
--
-- KEPT AS-IS: Arthur Rock FY18 $1M — one stock gift liquidated in five
-- brokerage tranches; five units correctly point at the one gift.
--
-- Requires 0197 + 0198. Idempotent (guards on rows still existing).
--
-- Apply after Publish, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0199_gift_shape_repairs_merges_splits.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

------------------------------------------------------------------------------
-- 1. Allocation-grain provenance: every QBO line in a merge group keeps a
--    qbo_line_allocation link to the allocation it generated. Written BEFORE
--    the merge so the mapping is captured while the units still exist.
------------------------------------------------------------------------------
INSERT INTO source_links (id, link_type, qb_staged_payment_id, gift_allocation_id, lifecycle, provenance, note)
SELECT 'srcl_qla_' || m.sp_id || '_' || m.alloc_id,
       'qbo_line_allocation', m.sp_id, m.alloc_id, 'confirmed', 'human',
       'gift shape repair 0199: line booked at allocation grain'
FROM (VALUES
  -- Fidelity $80k (gift reccnVv6dWZCMjS8J)
  ('2FuX80J7AL1P1FH8GbuWs', 'recn54OJ8yl4If71O'),   -- $15k ops guide
  ('vXurKXgrl7361WZxuOoQv', 'recZc92UM2w1QWGUC'),   -- $65k school grant
  -- WFF FY20 $850k (rec7qBf6qlLWmu5D2)
  ('shvXIP-SMlHdT8fZZV9j6', 'recDMkOZRBQeRai3h'),   -- $50k
  ('BcH6Hw4ninmauqVKie2Nz', 'recQlRLA2R0AYjCCS'),   -- $50k
  ('iWcGVxof9US2IHbvl1IXg', 'rec4gEASeZvJkgDj2'),   -- $150k
  ('PmmIGZKzT9EY5uVt4Ou8g', 'reci8KyJlX7oiqkw7'),   -- $600k
  -- Walton FY20 National $3M (recTSWQsF4XDa8tS7): 150k+850k lines fund the $1M allocation
  ('Xg33lA0g9jIkwwsr_pQZ6', 'recDeJSjuIvmZMWZu'),   -- $250k
  ('nq1-6f49H1TBkpzXQMeoD', 'rec4A595AGj564ILc'),   -- $1.75M
  ('GbX0-_DuADnbTToCOK5FX', 'recf6B2E8mhnAXZkk'),   -- $150k → $1M alloc
  ('14bK2L3U45_L68Pk0e8xb', 'recf6B2E8mhnAXZkk'),   -- $850k → $1M alloc
  -- Wend FY21 2nd $1M (recHiJbzwCh9TXOiw)
  ('Xx--QX-N0QfzN4HGJ6ooN', 'recpq2aO8i6T16P7Z'),   -- $100k
  ('0QRltKvs6-ZwwaHIhwPlX', 'recwwniKJcVkuu9J4'),   -- $250k
  ('8P07oj_mekALTJJVH3BVw', 'recS0SucreDBPT3bB'),   -- $650k
  -- Wend FY21 July $1M (recWdD0WK8PZgpwAj)
  ('03MJgvj2pV75gxWQpMewZ', 'recA58uHRzxgOrw0W'),   -- $100k
  ('lDAmTdpZaKvcLRhmZW8Le', 'rectkb5UbYvj9gTLO'),   -- $250k
  ('UrPCetXPt6fzUR2KFGSw4', 'rec7VMjzFKbrclLto'),   -- $650k
  -- Wend FY22 $750k (recYYzhmd91kAhuSr)
  ('V9w0QHroUBekyXuh9p7Rp', 'rec520FJYTQAPXEuC'),   -- $75k
  ('A-CcdATXVHKIYxuARdkE_', 'recywrjypjgD0lhGD'),   -- $200k
  ('yTsZT7LF15BV4d2x44NmC', 'rec9GIAZ8LnMwdJLw'),   -- $475k
  -- Wend FY22 Part 2 $750k (recp0EiOtwbdVzb5v)
  ('NEFBsM3TV7CQ2vnk94Mxt', 'recQT8C8zep66aYPJ'),   -- $75k
  ('bAdWhtHkGjPkLvrrGFUG3', 'recX6G2EFKTa5WswA'),   -- $200k
  ('i0CaaxPzKay-PJAmQVa9X', 'recAINBro8xFRvqYA'),   -- $475k
  -- Walton FY19 drawdown $325k: 7 lines → fy2020 allocation, 8th → fy2019
  ('3enxQRcHzrqfT72OtUpDr', 'synth-ga-recGK4rLK85kyhUCK'),
  ('4PNlhri0FK3hxs3PQEZ9e', 'synth-ga-recGK4rLK85kyhUCK'),
  ('DcyR45il6vZ-oKqXJGW1-', 'synth-ga-recGK4rLK85kyhUCK'),
  ('FdEhrYUxb3k3teh3GG4XH', 'synth-ga-recGK4rLK85kyhUCK'),
  ('I1M8SIuhyuEaEOeRo-xyh', 'synth-ga-recGK4rLK85kyhUCK'),
  ('h8pv4TzI8pDXAV1kO937x', 'synth-ga-recGK4rLK85kyhUCK'),
  ('RdLgow6ROBZKoWkT2uIEc', 'synth-ga-recGK4rLK85kyhUCK'),
  ('BgQFCw5ThrCZ3TfCVUSz_', 'synth-ga-reca1vNBLHpmJmmhs'),
  -- WFF FY21 (rec8CEP37lXIXkeIE): $800k wire booked as 50k+100k+650k lines,
  -- 650k line funds the 600k AND the second 50k allocation
  ('zNvq6Q8WQ0grdW4bpOt0j', 'recTGNQwnW9caTQb9'),   -- $50k
  ('QjsM0ONeAhRLWJ5VwvoES', 'recjkN8G2XjaTgtBJ'),   -- $100k
  ('E5ZSmY2RTuFShJ-sJrAWU', 'rechmKGEcGnQHConN'),   -- $650k → $600k alloc
  ('E5ZSmY2RTuFShJ-sJrAWU', 'recUhD4ycLscBaUB3'),   -- $650k → 2nd $50k alloc
  ('lwwqcgE4EvrIia3t9agYL', 'reczPX5dAz608y8eM')    -- $117k line/deposit
) AS m(sp_id, alloc_id)
WHERE EXISTS (SELECT 1 FROM staged_payments sp WHERE sp.id = m.sp_id)
  AND EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.id = m.alloc_id)
ON CONFLICT (qb_staged_payment_id, gift_allocation_id)
  WHERE link_type = 'qbo_line_allocation' DO NOTHING;

------------------------------------------------------------------------------
-- 2. Walton FY19 gift-record merge: fold reca1vNBLHpmJmmhs (the 8th $40,625
--    line's gift, fy2019 allocation) into recGK4rLK85kyhUCK; the merged gift
--    is the one $325,000 wire.
------------------------------------------------------------------------------
UPDATE gift_allocations
SET gift_id = 'recGK4rLK85kyhUCK', updated_at = now()
WHERE id = 'synth-ga-reca1vNBLHpmJmmhs' AND gift_id = 'reca1vNBLHpmJmmhs';

UPDATE payment_units SET gift_id = 'recGK4rLK85kyhUCK', updated_at = now()
WHERE id = 'pu_BgQFCw5ThrCZ3TfCVUSz_' AND gift_id = 'reca1vNBLHpmJmmhs';

UPDATE payment_applications SET gift_id = 'recGK4rLK85kyhUCK', updated_at = now()
WHERE payment_unit_id = 'pu_BgQFCw5ThrCZ3TfCVUSz_' AND gift_id = 'reca1vNBLHpmJmmhs';

UPDATE gifts_and_payments SET amount = 325000.00, updated_at = now()
WHERE id = 'recGK4rLK85kyhUCK' AND amount = 284375.00;

DELETE FROM gifts_and_payments WHERE id = 'reca1vNBLHpmJmmhs';

------------------------------------------------------------------------------
-- 3. Unit merges: survivor absorbs the group sum; the other units (QBO
--    allocation-grain lines, provenance preserved in step 1) are removed
--    together with their counted ledger rows.
------------------------------------------------------------------------------
CREATE TEMP TABLE _merge_groups (survivor text, merged_sum numeric, deposit_id text) ON COMMIT DROP;
INSERT INTO _merge_groups VALUES
  ('pu_vXurKXgrl7361WZxuOoQv',   80000.00, 'bdep_fdaf5e42f6f5ac0556ce564b'), -- Fidelity
  ('pu_PmmIGZKzT9EY5uVt4Ou8g',  850000.00, 'bdep_f3803c588510bd1875d3de73'), -- WFF FY20
  ('pu_nq1-6f49H1TBkpzXQMeoD', 3000000.00, 'bdep_c57e57f98bc27146fa2c8246'), -- Walton FY20
  ('pu_8P07oj_mekALTJJVH3BVw', 1000000.00, 'bdep_df7b10aac020c2622504c475'), -- Wend FY21 2nd
  ('pu_UrPCetXPt6fzUR2KFGSw4', 1000000.00, 'bdep_983a7409cabcecf1a12b5c3d'), -- Wend FY21 July
  ('pu_yTsZT7LF15BV4d2x44NmC',  750000.00, 'bdep_bdd0b5b3531c199ac841b19b'), -- Wend FY22
  ('pu_i0CaaxPzKay-PJAmQVa9X',  750000.00, 'bdep_3148212ec41e5e5ce7444ffc'), -- Wend FY22 P2
  ('pu_RdLgow6ROBZKoWkT2uIEc',  325000.00, 'bdep_1847a3d3fe06aea80839abbd'), -- Walton FY19 (8×40,625)
  ('pu_E5ZSmY2RTuFShJ-sJrAWU',  800000.00, 'bdep_7cdf93aea7ee4f73c60b9640'); -- WFF FY21 $800k wire

CREATE TEMP TABLE _merge_removed (unit_id text) ON COMMIT DROP;
INSERT INTO _merge_removed VALUES
  ('pu_2FuX80J7AL1P1FH8GbuWs'),                                                -- Fidelity $15k
  ('pu_shvXIP-SMlHdT8fZZV9j6'), ('pu_BcH6Hw4ninmauqVKie2Nz'), ('pu_iWcGVxof9US2IHbvl1IXg'),   -- WFF FY20
  ('pu_GbX0-_DuADnbTToCOK5FX'), ('pu_Xg33lA0g9jIkwwsr_pQZ6'), ('pu_14bK2L3U45_L68Pk0e8xb'),   -- Walton FY20
  ('pu_Xx--QX-N0QfzN4HGJ6ooN'), ('pu_0QRltKvs6-ZwwaHIhwPlX'),                                 -- Wend FY21 2nd
  ('pu_03MJgvj2pV75gxWQpMewZ'), ('pu_lDAmTdpZaKvcLRhmZW8Le'),                                 -- Wend FY21 July
  ('pu_V9w0QHroUBekyXuh9p7Rp'), ('pu_A-CcdATXVHKIYxuARdkE_'),                                 -- Wend FY22
  ('pu_NEFBsM3TV7CQ2vnk94Mxt'), ('pu_bAdWhtHkGjPkLvrrGFUG3'),                                 -- Wend FY22 P2
  ('pu_3enxQRcHzrqfT72OtUpDr'), ('pu_4PNlhri0FK3hxs3PQEZ9e'), ('pu_DcyR45il6vZ-oKqXJGW1-'),   -- Walton FY19
  ('pu_FdEhrYUxb3k3teh3GG4XH'), ('pu_I1M8SIuhyuEaEOeRo-xyh'), ('pu_h8pv4TzI8pDXAV1kO937x'),
  ('pu_BgQFCw5ThrCZ3TfCVUSz_'),
  ('pu_zNvq6Q8WQ0grdW4bpOt0j'), ('pu_QjsM0ONeAhRLWJ5VwvoES');                                 -- WFF FY21

DELETE FROM payment_applications
WHERE payment_unit_id IN (SELECT unit_id FROM _merge_removed);

-- Fidelity's removed twin component goes first (FK); its survivor's
-- component resizes to the whole deposit.
DELETE FROM bank_deposit_components WHERE id = 'bdc_2FuX80J7AL1P1FH8GbuWs';
UPDATE bank_deposit_components SET amount = 80000.00, updated_at = now()
WHERE id = 'bdc_vXurKXgrl7361WZxuOoQv' AND amount IS DISTINCT FROM 80000.00;

DELETE FROM payment_units WHERE id IN (SELECT unit_id FROM _merge_removed);

UPDATE payment_units pu
SET gross_amount = g.merged_sum, updated_at = now()
FROM _merge_groups g
WHERE pu.id = g.survivor AND pu.gross_amount IS DISTINCT FROM g.merged_sum;

UPDATE payment_applications pa
SET amount_applied = g.merged_sum, updated_at = now()
FROM _merge_groups g
WHERE pa.payment_unit_id = g.survivor AND pa.link_role = 'counted'
  AND pa.amount_applied IS DISTINCT FROM g.merged_sum;

-- The one physical payment ties to its (sum-matching, verified) bank deposit
-- (Fidelity's survivor already had one, resized above).
INSERT INTO bank_deposit_components
  (id, bank_deposit_id, payment_unit_id, amount, source, needs_review,
   ambiguous_deposit_match, classification_source)
SELECT 'bdc_' || substr(g.survivor, 4), g.deposit_id, g.survivor,
       g.merged_sum, 'manual', false, false, 'manual'
FROM _merge_groups g
WHERE g.survivor <> 'pu_vXurKXgrl7361WZxuOoQv'
  AND EXISTS (SELECT 1 FROM payment_units pu WHERE pu.id = g.survivor)
  AND EXISTS (SELECT 1 FROM bank_deposits d WHERE d.id = g.deposit_id)
  AND NOT EXISTS (
    SELECT 1 FROM bank_deposit_components c WHERE c.payment_unit_id = g.survivor
  );

------------------------------------------------------------------------------
-- 4. Installment splits: one gift record per physical payment. New gifts
--    copy the parent's identity fields; units and their counted ledger rows
--    repoint in the same transaction (pointer/ledger stay in lockstep).
------------------------------------------------------------------------------
INSERT INTO gifts_and_payments
  (id, name, details, date_received, amount,
   individual_giver_person_id, opportunity_id, advisor_person_id,
   primary_contact_person_id, payment_intermediary_id, payment_method,
   owner_user_id, household_id, organization_id, loan_or_grant,
   fundraising_campaign, campaign_slug)
SELECT v.new_id, p.name || v.name_suffix, p.details, v.recv_date, v.amt,
       p.individual_giver_person_id, p.opportunity_id, p.advisor_person_id,
       p.primary_contact_person_id, p.payment_intermediary_id, p.payment_method,
       p.owner_user_id, p.household_id, p.organization_id, p.loan_or_grant,
       p.fundraising_campaign, p.campaign_slug
FROM (VALUES
  ('gift_split_walton_fy18_120k',  'rec2Yg2bd1cagK17V', ' — $120k installment (1/19/2018)',  '2018-01-19'::date,  120000.00),
  ('gift_split_springpoint_350k',  'recJG0TYivBR4zaVq', ' — $350k installment (12/21/2020)', '2020-12-21',        350000.00),
  ('gift_split_wff_fy19_200k',     'recRY1v6YWvUXncOo', ' — $200k installment (4/1/2019)',   '2019-04-01',        200000.00),
  ('gift_split_peretsman_4674',    'recLvQ1QfqDncBpea', ' — $4,673.98 installment (12/20/2019)', '2019-12-20',      4673.98),
  ('gift_split_wff_fy21_117k',     'rec8CEP37lXIXkeIE', ' — $117k installment (5/20/2020)',  '2020-05-20',        117000.00)
) AS v(new_id, parent_id, name_suffix, recv_date, amt)
JOIN gifts_and_payments p ON p.id = v.parent_id
ON CONFLICT (id) DO NOTHING;

-- Parent gifts shrink to their remaining installment.
UPDATE gifts_and_payments g SET amount = v.amt, updated_at = now()
FROM (VALUES
  ('rec2Yg2bd1cagK17V', 600000.00),
  ('recJG0TYivBR4zaVq', 1000000.00),
  ('recRY1v6YWvUXncOo', 475000.00),
  ('recLvQ1QfqDncBpea', 95326.02),
  ('rec8CEP37lXIXkeIE', 800000.00)
) AS v(gift_id, amt)
WHERE g.id = v.gift_id AND g.amount IS DISTINCT FROM v.amt;

-- Units + counted ledger rows move to their installment gift together.
UPDATE payment_units pu SET gift_id = v.new_gift, updated_at = now()
FROM (VALUES
  ('pu_dbVY7ag4YNyIuGeWKQQYJ', 'gift_split_walton_fy18_120k'),
  ('pu_bNV4aWaSFxHX2wfGLHHDq', 'gift_split_springpoint_350k'),
  ('pu_To-pU5ogf6SFa7GudD79y', 'gift_split_wff_fy19_200k'),
  ('pu_6qEbcNxV-MEST0vBuBv4K', 'gift_split_peretsman_4674'),
  ('pu_lwwqcgE4EvrIia3t9agYL', 'gift_split_wff_fy21_117k')
) AS v(unit_id, new_gift)
WHERE pu.id = v.unit_id AND pu.gift_id IS DISTINCT FROM v.new_gift;

UPDATE payment_applications pa SET gift_id = v.new_gift, updated_at = now()
FROM (VALUES
  ('pu_dbVY7ag4YNyIuGeWKQQYJ', 'gift_split_walton_fy18_120k'),
  ('pu_bNV4aWaSFxHX2wfGLHHDq', 'gift_split_springpoint_350k'),
  ('pu_To-pU5ogf6SFa7GudD79y', 'gift_split_wff_fy19_200k'),
  ('pu_6qEbcNxV-MEST0vBuBv4K', 'gift_split_peretsman_4674'),
  ('pu_lwwqcgE4EvrIia3t9agYL', 'gift_split_wff_fy21_117k')
) AS v(unit_id, new_gift)
WHERE pa.payment_unit_id = v.unit_id AND pa.link_role = 'counted'
  AND pa.gift_id IS DISTINCT FROM v.new_gift;

-- Allocations follow the money they describe.
--   Spring Point: $350k allocation → $350k installment.
--   WFF FY19: $50k + $150k allocations → $200k installment.
--   WFF FY21: $117k allocation → $117k installment.
UPDATE gift_allocations SET gift_id = v.new_gift, updated_at = now()
FROM (VALUES
  ('rec5pOKw9QN4zgqGw', 'gift_split_springpoint_350k'),
  ('recG0UJpAyOLTbURQ', 'gift_split_wff_fy19_200k'),
  ('recXIJMNr2fQXmydf', 'gift_split_wff_fy19_200k'),
  ('reczPX5dAz608y8eM', 'gift_split_wff_fy21_117k')
) AS v(alloc_id, new_gift)
WHERE gift_allocations.id = v.alloc_id
  AND gift_allocations.gift_id IS DISTINCT FROM v.new_gift;

--   Walton FY18: allocations 460k/200k/60k vs installments 600k/120k — the
--   $200k fy2018 allocation spans both wires: $140k stays with the $600k
--   installment, $60k moves to the $120k one (owner-reviewed division).
UPDATE gift_allocations SET sub_amount = 140000.00, updated_at = now(),
  variance_reason = COALESCE(variance_reason || ' | ', '')
    || '0199: $200k allocation divided $140k/$60k across the two installment wires'
WHERE id = 'recAgyDqbhBuORDGh' AND sub_amount = 200000.00;

INSERT INTO gift_allocations (id, gift_id, sub_amount, grant_year, variance_reason)
SELECT 'ga_split_walton_fy18_60k', 'gift_split_walton_fy18_120k', 60000.00, 'fy2018',
       '0199: $60k share of the divided $200k allocation'
WHERE EXISTS (SELECT 1 FROM gifts_and_payments WHERE id = 'gift_split_walton_fy18_120k')
  AND NOT EXISTS (SELECT 1 FROM gift_allocations WHERE id = 'ga_split_walton_fy18_60k');

UPDATE gift_allocations SET gift_id = 'gift_split_walton_fy18_120k', updated_at = now()
WHERE id = 'recoXXZokd8XWmdQm'                       -- the $60k fy2018 allocation
  AND gift_id IS DISTINCT FROM 'gift_split_walton_fy18_120k';

--   Peretsman: the synthetic $100k allocation resizes to the parent's
--   $95,326.02; the new installment gets its own.
UPDATE gift_allocations SET sub_amount = 95326.02, updated_at = now()
WHERE id = 'synth-ga-recLvQ1QfqDncBpea' AND sub_amount = 100000.00;

INSERT INTO gift_allocations (id, gift_id, sub_amount, grant_year)
SELECT 'ga_split_peretsman_4674', 'gift_split_peretsman_4674', 4673.98, 'fy2020'
WHERE EXISTS (SELECT 1 FROM gifts_and_payments WHERE id = 'gift_split_peretsman_4674')
  AND NOT EXISTS (SELECT 1 FROM gift_allocations WHERE id = 'ga_split_peretsman_4674');

------------------------------------------------------------------------------
-- 5. Post-conditions (fail loudly rather than commit a bad shape).
------------------------------------------------------------------------------
DO $$
DECLARE bad int;
BEGIN
  -- Every counted ledger row agrees with its unit's pointer.
  SELECT count(*) INTO bad FROM payment_applications pa
  JOIN payment_units pu ON pu.id = pa.payment_unit_id
  WHERE pa.link_role = 'counted' AND pu.gift_id IS DISTINCT FROM pa.gift_id;
  IF bad > 0 THEN RAISE EXCEPTION '0199: % counted ledger/pointer mismatches', bad; END IF;

  -- Each repaired gift's allocations sum to the gift amount.
  SELECT count(*) INTO bad FROM gifts_and_payments g
  JOIN LATERAL (
    SELECT COALESCE(sum(sub_amount), 0) s FROM gift_allocations ga WHERE ga.gift_id = g.id
  ) a ON true
  WHERE g.id IN ('reccnVv6dWZCMjS8J','rec7qBf6qlLWmu5D2','recTSWQsF4XDa8tS7',
                 'recHiJbzwCh9TXOiw','recWdD0WK8PZgpwAj','recYYzhmd91kAhuSr',
                 'recp0EiOtwbdVzb5v','recGK4rLK85kyhUCK','rec2Yg2bd1cagK17V',
                 'recJG0TYivBR4zaVq','recRY1v6YWvUXncOo','recLvQ1QfqDncBpea',
                 'rec8CEP37lXIXkeIE','gift_split_walton_fy18_120k',
                 'gift_split_springpoint_350k','gift_split_wff_fy19_200k',
                 'gift_split_peretsman_4674','gift_split_wff_fy21_117k')
    AND a.s <> g.amount;
  IF bad > 0 THEN RAISE EXCEPTION '0199: % gifts whose allocations do not sum to the gift amount', bad; END IF;

  -- Each repaired gift's counted units sum to the gift amount.
  SELECT count(*) INTO bad FROM gifts_and_payments g
  JOIN LATERAL (
    SELECT COALESCE(sum(gross_amount), 0) s FROM payment_units pu WHERE pu.gift_id = g.id
  ) u ON true
  WHERE g.id IN ('reccnVv6dWZCMjS8J','rec7qBf6qlLWmu5D2','recTSWQsF4XDa8tS7',
                 'recHiJbzwCh9TXOiw','recWdD0WK8PZgpwAj','recYYzhmd91kAhuSr',
                 'recp0EiOtwbdVzb5v','recGK4rLK85kyhUCK','rec2Yg2bd1cagK17V',
                 'recJG0TYivBR4zaVq','recRY1v6YWvUXncOo','recLvQ1QfqDncBpea',
                 'rec8CEP37lXIXkeIE','gift_split_walton_fy18_120k',
                 'gift_split_springpoint_350k','gift_split_wff_fy19_200k',
                 'gift_split_peretsman_4674','gift_split_wff_fy21_117k')
    AND u.s <> g.amount;
  IF bad > 0 THEN RAISE EXCEPTION '0199: % gifts whose units do not sum to the gift amount', bad; END IF;
END $$;
