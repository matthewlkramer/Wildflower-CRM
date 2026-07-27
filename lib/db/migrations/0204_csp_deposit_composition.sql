-- 0204: resolve composition for the CSP wire deposits (owner rulings
-- 2026-07-23). Each deposit is a single wire from the U.S. Department of
-- Education against the $12.7M "CMO Replication Grant - pass through funds"
-- pledge (recX8CNJdnAq66sdR):
--
--   * 26 deposits whose memo contains "CSP" (the $19.86 Gusto deposit whose
--     ref string happens to contain "csp" is skipped), plus
--   * 8 owner-confirmed "ONLINE TRANSFER" deposits without "CSP" in the memo.
--
-- 33 of the 34 already have an exact-amount gift (with unit + allocations) on
-- the pledge; they get a single-wire bank_deposit_component tying the deposit
-- to that unit. The one without ($210,713.94, 2026-04-09, "MAR26 CSP OP EXP
-- AND IC OCT TO MAR") gets a new gift with a single allocation mirroring the
-- other CSP reimbursement coding (fy2026 / gen_ops / wildflower_foundation /
-- counts_toward_goal false / unrestricted), a wire payment unit, and its
-- component.
--
-- Two of the confirmed online-transfer deposits carried a stale 0176
-- intercompany_transfer exclusion; those exclusions are removed.
--
-- Idempotent (deterministic ids, fill-only inserts, guarded updates).
--
-- Apply after Publish, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0204_csp_deposit_composition.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

------------------------------------------------------------------------------
-- 1. Remove the stale intercompany-transfer exclusions on the two confirmed
--    CSP deposits.
------------------------------------------------------------------------------
DELETE FROM bank_deposit_exclusions
WHERE bank_deposit_id IN
  ('bdep_7f3d66bdc664f5f635967e46', 'bdep_3cd12fedfad583293a864ae3');

------------------------------------------------------------------------------
-- 2. New gift + single allocation + wire unit for the one CSP deposit with
--    no existing gift on the pledge.
------------------------------------------------------------------------------
INSERT INTO gifts_and_payments
  (id, name, date_received, amount, organization_id, opportunity_id,
   owner_user_id, loan_or_grant)
SELECT 'csp-gift-mar26-opex-ic', 'CMO Replication Grant - CSP reimbursement 2026-04-09',
       DATE '2026-04-09', 210713.94, 'recHG2Cva8hJRzB6Y', 'recX8CNJdnAq66sdR',
       'usr_matthew_kramer', 'grant'
WHERE NOT EXISTS
  (SELECT 1 FROM gifts_and_payments WHERE id = 'csp-gift-mar26-opex-ic');

INSERT INTO gift_allocations
  (id, gift_id, sub_amount, grant_year, intended_usage, entity_id,
   display_usage, counts_toward_goal, regional_restriction_type,
   other_restriction_type, time_restriction_type, seed_fund)
SELECT 'csp-ga-mar26-opex-ic', 'csp-gift-mar26-opex-ic', 210713.94, 'fy2026',
       'gen_ops', 'wildflower_foundation', 'Gen Ops', false, 'unrestricted',
       'unrestricted', 'unrestricted', false
WHERE NOT EXISTS
  (SELECT 1 FROM gift_allocations WHERE id = 'csp-ga-mar26-opex-ic');

INSERT INTO payment_units
  (id, kind, gross_amount, net_amount, currency, received_date, lifecycle,
   gift_id, gift_match_method, gift_confirmed_by_user_id, gift_confirmed_at,
   created_the_gift)
SELECT 'pu_csp-mar26-opex-ic', 'wire', 210713.94, 210713.94, 'USD',
       DATE '2026-04-09', 'received', 'csp-gift-mar26-opex-ic', 'human',
       'usr_matthew_kramer', now(), true
WHERE NOT EXISTS
  (SELECT 1 FROM payment_units WHERE id = 'pu_csp-mar26-opex-ic');

------------------------------------------------------------------------------
-- 3. Single-wire components: deposit ← unit at the deposit's full amount.
------------------------------------------------------------------------------
INSERT INTO bank_deposit_components
  (id, bank_deposit_id, payment_unit_id, amount, source, needs_review,
   classification_source)
SELECT 'bdc_csp_' || replace(m.dep_id, 'bdep_', ''), m.dep_id, m.unit_id,
       m.amt, 'manual', false, 'manual'
FROM (VALUES
  ('bdep_09af0fb19a172c64a9b15fcd', 'pu_L9We0jG9T4JGrodyzCboz',  49875.08),
  ('bdep_f927e42f74c8493ab49aa9fa', 'pu_ZujzIaNrAykMCIqybfgGt',  53679.53),
  ('bdep_c94c2199c0afc84006e16865', 'pu_1j9tsOb5RDCcZ8cPu8Chr',  69833.29),
  ('bdep_c29be282d42555e0074741cf', 'pu_DPfAFjulUPT5B0f3ngSTi', 133923.82),
  ('bdep_3b84602205ad94a455470d35', 'pu_NbeusM49NwHdDgZkARDun',  50588.13),
  ('bdep_280bbccf14dfcbbcd9399525', 'pu_3q7zH4VLQ0bZCV70yoMTY', 100549.31),
  ('bdep_8fd0db57e00f6cd6781da8b2', 'pu_CDIJFjWfndjENrLjbNK5Z', 107587.12),
  ('bdep_7a533aebcf9616bf240b57fa', 'pu_VnP-3NQCOqSLQoaEMp454',  45172.76),
  ('bdep_cae75f0f58f957ba48944e04', 'pu_eNQxQ3tm5SRWHJADsbK0O', 129062.02),
  ('bdep_f8eb50b50de2927115bc7771', 'pu_zl6dgU1RKoTwbIRHFyru5',  59786.70),
  ('bdep_7f3d66bdc664f5f635967e46', 'pu_5Y1_RQ7tyyb1XLaxSrEBx',  76365.75),
  ('bdep_3cd12fedfad583293a864ae3', 'pu_UQEuXXTcr4JBh9xo7BxKO',  31702.02),
  ('bdep_4cc791b4fcf7e7f64ba05ff5', 'pu_eRda7lfosGWxA3CbV2LX4',  51644.11),
  ('bdep_82e8d826bbcc504453056403', 'pu_IHH82ntNzoplvAYKkJnQO',  24255.47),
  ('bdep_e859f5ddf564893bf7ab7ce0', 'pu_hgztME5XGAxk-A0_ehoX7',  52686.81),
  ('bdep_2e0ecc5651ab4e865d564d9b', 'pu_mX_QwYzSnjiuiKEx81KRP',  79189.06),
  ('bdep_d3299e8e2422ca1751a7fe7d', 'pu_2q_E8X9AyUeJAXcg2hE5D',  51781.56),
  ('bdep_6d30ae8cf4fe46cba4b7c532', 'pu_n05VjKs3yE-cY40mItQs-', 103599.75),
  ('bdep_ae869e1cc3d546a7955990e6', 'pu_lcB1Kuppcsg0UhLtuJnNg',  58653.43),
  ('bdep_b3b8d4e1a7406e8142b0f6e4', 'pu_dzyXZQGgQd2sHDKUCRhGl', 167897.19),
  ('bdep_83a70b01417b63606a9728a0', 'pu_W3FRhvHCc1UQ0ANLQ1Epf',   3280.00),
  ('bdep_0501311e25593970b7f5028b', 'pu_iApQ2VpSo-uMiFBT9q4Te', 112125.06),
  ('bdep_a6a9247cf8d08d55e667fa26', 'pu_cLNQ2CzfDVh5uTBOClYio',  57925.52),
  ('bdep_1e7808d2d64a202cd3296ffa', 'pu_csp-mar26-opex-ic',     210713.94),
  ('bdep_10bd30e844eeb03778954a83', 'pu_lJyS6Y5znQl3ePESuzUBF', 104288.61),
  ('bdep_1f15ed266fa531c05e97b4df', 'pu_VvVCxZL2lIiFpjuVtK238',  50858.97),
  ('bdep_9f3fbbb38164674f0ef7955b', 'pu_3dPCJKMWa7hNJiDbzofGv', 192414.68),
  ('bdep_8f46409373edd73fa1e5936a', 'pu_K-iAVyrXcSevlF6q1FsS5',  23168.51),
  ('bdep_89f32620ae36786b3b2f6f49', 'pu_AtF0s6lJ9xFM4CWcNWCdD', 292165.52),
  ('bdep_b54cd9c212c8672c8a1abfd5', 'pu_dWXDkyPw-MH5nSroEGQ4-',  48739.60),
  ('bdep_7cb6ae97c095b89b0595ff94', 'pu_JttfuTw1WSwNVZv6BbOgu',   8469.30),
  ('bdep_039ce25b2ee452bb9c283a30', 'pu_DzACu6FiQu1H0X-Et3f1L',   8825.00),
  ('bdep_7f2d3623cfddf6569d2d674e', 'pu_o5JG7qUSAS0Z2rGS4RBrU',  39648.42),
  ('bdep_b62cf9d0689a8dec7e70f6a5', 'pu_lC7ichpWOWj_PTOdDe_PK',  45235.11)
) AS m(dep_id, unit_id, amt)
WHERE EXISTS (SELECT 1 FROM bank_deposits d WHERE d.id = m.dep_id)
  AND EXISTS (SELECT 1 FROM payment_units pu WHERE pu.id = m.unit_id)
  AND NOT EXISTS (SELECT 1 FROM bank_deposit_components bdc
                  WHERE bdc.bank_deposit_id = m.dep_id)
ON CONFLICT (id) DO NOTHING;

------------------------------------------------------------------------------
-- 4. Post-conditions (fail loudly rather than commit a bad shape).
------------------------------------------------------------------------------
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM bank_deposits d
  LEFT JOIN LATERAL (
    SELECT count(*) n, COALESCE(sum(amount), 0) s
    FROM bank_deposit_components bdc WHERE bdc.bank_deposit_id = d.id
  ) c ON true
  WHERE d.id LIKE 'bdep_%'
    AND d.id IN
      ('bdep_09af0fb19a172c64a9b15fcd','bdep_f927e42f74c8493ab49aa9fa',
       'bdep_c94c2199c0afc84006e16865','bdep_c29be282d42555e0074741cf',
       'bdep_3b84602205ad94a455470d35','bdep_280bbccf14dfcbbcd9399525',
       'bdep_8fd0db57e00f6cd6781da8b2','bdep_7a533aebcf9616bf240b57fa',
       'bdep_cae75f0f58f957ba48944e04','bdep_f8eb50b50de2927115bc7771',
       'bdep_7f3d66bdc664f5f635967e46','bdep_3cd12fedfad583293a864ae3',
       'bdep_4cc791b4fcf7e7f64ba05ff5','bdep_82e8d826bbcc504453056403',
       'bdep_e859f5ddf564893bf7ab7ce0','bdep_2e0ecc5651ab4e865d564d9b',
       'bdep_d3299e8e2422ca1751a7fe7d','bdep_6d30ae8cf4fe46cba4b7c532',
       'bdep_ae869e1cc3d546a7955990e6','bdep_b3b8d4e1a7406e8142b0f6e4',
       'bdep_83a70b01417b63606a9728a0','bdep_0501311e25593970b7f5028b',
       'bdep_a6a9247cf8d08d55e667fa26','bdep_1e7808d2d64a202cd3296ffa',
       'bdep_10bd30e844eeb03778954a83','bdep_1f15ed266fa531c05e97b4df',
       'bdep_9f3fbbb38164674f0ef7955b','bdep_8f46409373edd73fa1e5936a',
       'bdep_89f32620ae36786b3b2f6f49','bdep_b54cd9c212c8672c8a1abfd5',
       'bdep_7cb6ae97c095b89b0595ff94','bdep_039ce25b2ee452bb9c283a30',
       'bdep_7f2d3623cfddf6569d2d674e','bdep_b62cf9d0689a8dec7e70f6a5')
    AND (c.n <> 1 OR c.s <> d.amount);
  IF bad > 0 THEN
    RAISE EXCEPTION '0204: % CSP deposits whose single component does not equal the deposit amount', bad;
  END IF;

  SELECT count(*) INTO bad FROM gifts_and_payments g
  JOIN LATERAL (
    SELECT COALESCE(sum(sub_amount), 0) s FROM gift_allocations ga WHERE ga.gift_id = g.id
  ) a ON true
  JOIN LATERAL (
    SELECT COALESCE(sum(gross_amount), 0) s FROM payment_units pu WHERE pu.gift_id = g.id
  ) u ON true
  WHERE g.id = 'csp-gift-mar26-opex-ic'
    AND (a.s <> g.amount OR u.s <> g.amount);
  IF bad > 0 THEN
    RAISE EXCEPTION '0204: new CSP gift allocations/units do not sum to the gift amount';
  END IF;
END $$;
