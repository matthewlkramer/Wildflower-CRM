-- 0211: resolve the held-back collision rows from the 0210 review (owner
-- rulings 2026-07-27) using bank-history payer patterns (Valhalla wires come
-- via JPMorgan; Wend arrives as WEND LLC / WEND II INC ACH, grant 2020-162
-- installment series):
--   bdep_4388dca7c40b6753ce0d3e61  2023-02-13 $500k JPM /ORG=VALHALLA
--     -> gift F-mLU13c5LshbcHAt2dwC "Valhalla Foundation"
--   bdep_4c682821ad12d355dd6660c8  2023-02-13 $500k WEND II (2020-162_6)
--     -> gift rec6WBYG2LHDQ69vm "Wend National FY23 #2"
--   bdep_a8322cc5bae179f2363f664d  2022-08-15 $500k WEND LLC (2020-162_5)
--     -> gift recrveD3kAFXE1z6t "Wend National FY23"
--   bdep_c02f0336052b3958836b9f54  2023-05-19 $40k Ed Forward (Bill.com)
--     -> gift recqcIeQ6yxyBf5ZS "Ed Forward for BWF $40,000 FY23"
--   bdep_2e01941170f5f4cb2b474f24  2023-06-20 $40k WEND II (2023-859)
--     -> gift recd5PHpq4wer9iKa "FY23 $40K Wend Black Wildflowers"
-- Each gift already has exactly one untied payment unit at the deposit
-- amount; only the bank component is created here. Also excludes the $550
-- Broadstreet Impact Services deposit (loan-servicing refund, owner ruling).
--
-- Idempotent; prod-only data repair; no Publish needed:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0211_wend_valhalla_edforward_links.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

INSERT INTO bank_deposit_components
  (id, bank_deposit_id, payment_unit_id, amount, source, needs_review,
   classification_source)
SELECT 'bdc_wb_'||md5(m.dep_id||'|'||m.unit_id), m.dep_id, m.unit_id, m.amt,
       'manual', false, 'manual'
FROM (VALUES
  ('bdep_4388dca7c40b6753ce0d3e61', 'pu_PYlhJyS-2I723XzG02HyN', 500000.00),
  ('bdep_4c682821ad12d355dd6660c8', 'pu_URM0w5zrV0KK7hbCHR4eB', 500000.00),
  ('bdep_a8322cc5bae179f2363f664d', 'pu_Pz6ngMwwjr-y0HehQUyzH', 500000.00),
  ('bdep_c02f0336052b3958836b9f54', 'pu_qAlSFuT4s_tsThMs1PE14',  40000.00),
  ('bdep_2e01941170f5f4cb2b474f24', 'pu_Ak_wEEHTDs2_IrZrHo4OB',  40000.00)
) AS m(dep_id, unit_id, amt)
WHERE EXISTS (SELECT 1 FROM bank_deposits d WHERE d.id = m.dep_id)
  AND EXISTS (SELECT 1 FROM payment_units u WHERE u.id = m.unit_id AND u.gift_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM bank_deposit_components b
                  WHERE b.bank_deposit_id = m.dep_id)
  AND NOT EXISTS (SELECT 1 FROM bank_deposit_components b
                  WHERE b.payment_unit_id = m.unit_id)
  AND NOT EXISTS (SELECT 1 FROM bank_deposit_exclusions e
                  WHERE e.bank_deposit_id = m.dep_id)
ON CONFLICT (id) DO NOTHING;

INSERT INTO bank_deposit_exclusions (id, bank_deposit_id, reason, note, created_by_user_id)
SELECT 'bdex_' || v.dep_id, v.dep_id, v.reason, v.note, 'usr_matthew_kramer'
FROM (VALUES
  ('bdep_8ce3f730e1aaa204828b6b06', 'expense_refund'::staged_payment_exclusion_reason,
   'Broadstreet Impact Services loan-servicing refund (owner ruling 2026-07-27)')
) AS v(dep_id, reason, note)
WHERE EXISTS (SELECT 1 FROM bank_deposits d WHERE d.id = v.dep_id)
  AND NOT EXISTS (SELECT 1 FROM bank_deposit_components b WHERE b.bank_deposit_id = v.dep_id)
ON CONFLICT (bank_deposit_id) DO NOTHING;

-- Post-condition: the five deposits are fully composed.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT d.id, d.amount, COALESCE(sum(b.amount),0) comp_sum
    FROM bank_deposits d
    LEFT JOIN bank_deposit_components b ON b.bank_deposit_id = d.id
    WHERE d.id IN ('bdep_4388dca7c40b6753ce0d3e61','bdep_4c682821ad12d355dd6660c8',
                   'bdep_a8322cc5bae179f2363f664d','bdep_c02f0336052b3958836b9f54',
                   'bdep_2e01941170f5f4cb2b474f24')
    GROUP BY d.id, d.amount
  LOOP
    IF r.comp_sum <> r.amount AND r.comp_sum <> 0 THEN
      RAISE EXCEPTION '0211: % components sum to % (expected %)', r.id, r.comp_sum, r.amount;
    END IF;
  END LOOP;
END $$;
