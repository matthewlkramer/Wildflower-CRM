-- 0214: exclude 28 Bill.com AR receivable batch deposits as membership money.
--
-- Each of these componentless, non-excluded "Bill.com Receivable" deposits was
-- verified against staged_payments line evidence: the deposit amount
-- reconciles EXACTLY (to the cent) to a set of school membership payments
-- (exclusion_reason = 'membership', qb_entity_type = 'payment') received in
-- the seven days before the deposit — the per-school detail behind the
-- "BILL … AR Payments" batch journal. They are school-receivable batches, not
-- fundraising gifts.
--
-- Left alone (no exact membership composition — need an owner ruling):
--   bdep_d697a9624f5b3cbe637b8ac3  $500.00    2026-06-05  VoidPaymnt (Janai Crudup)
--   bdep_6e48eb2cb3ec9c86a8963463  $4,621.90  2025-12-24  VoidPaymnt (Fab Ideas Coop)
--
-- Idempotent: deterministic ids + ON CONFLICT DO NOTHING; guarded to skip any
-- deposit that has since gained components or an exclusion.
--
-- Apply after merge, by a human (prod-only data repair; no Publish needed):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0214_exclude_billcom_membership_batches.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

INSERT INTO bank_deposit_exclusions (id, bank_deposit_id, reason, note, created_by_user_id)
SELECT 'bdex_' || v.dep_id, v.dep_id, 'membership'::staged_payment_exclusion_reason,
  'Bill.com AR membership batch — amount reconciles exactly to school membership staged payments received in the prior week (line-evidence match 2026-07-23)',
  'usr_matthew_kramer'
FROM (VALUES
  ('bdep_022fd7ab7053a5ad3c6cc32f'),
  ('bdep_0cedfd01e238056bb92e0733'),
  ('bdep_137d19c783d11e58d6df9d8d'),
  ('bdep_1537cbaaf09812ea73ca07dd'),
  ('bdep_18947e915fb2f9f9b7cddc40'),
  ('bdep_2140f2ae93465181bc79f10c'),
  ('bdep_493546b095ba78508acbe3b9'),
  ('bdep_4a0bfb4ef7852072acc6e095'),
  ('bdep_4a83d5638bab4ac709e1de20'),
  ('bdep_56244bebc9f0b7641d678295'),
  ('bdep_56779b477b85a5ed98c71809'),
  ('bdep_56be3ba0e65b64b8268a7e93'),
  ('bdep_65e91cad46b98e707972ac28'),
  ('bdep_73c0ccadc64d73016ddd20e6'),
  ('bdep_89dad06e408cb939d6ae3e4e'),
  ('bdep_8afe2dd61f821bfb96dfb940'),
  ('bdep_8f17666a9ff8524ff2b8a8a8'),
  ('bdep_8fc0225162071ba3152eb4f8'),
  ('bdep_a34791fae0e37a139e73c8cc'),
  ('bdep_a9ba25e5bafff006827b969e'),
  ('bdep_ac52ae1d63b713d13584cf02'),
  ('bdep_ba067e2735aed4f1493bb5cd'),
  ('bdep_bc2cfd0de0ebf5e0471317b9'),
  ('bdep_c03cc220f8c4d504719f5761'),
  ('bdep_c8af6752e89b0940d4140809'),
  ('bdep_e0187d0b0619bd7e8cdf56a5'),
  ('bdep_f03f86d4fece24a248515807'),
  ('bdep_f9dd8ac6b5d92331d00aaa9b')
) AS v(dep_id)
WHERE EXISTS (SELECT 1 FROM bank_deposits d WHERE d.id = v.dep_id)
  AND NOT EXISTS (SELECT 1 FROM bank_deposit_components c WHERE c.bank_deposit_id = v.dep_id)
  AND NOT EXISTS (SELECT 1 FROM bank_deposit_exclusions e WHERE e.bank_deposit_id = v.dep_id)
ON CONFLICT DO NOTHING;

DO $$
DECLARE excluded int;
BEGIN
  SELECT count(*) INTO excluded
  FROM bank_deposit_exclusions e
  WHERE e.bank_deposit_id IN (
    'bdep_022fd7ab7053a5ad3c6cc32f','bdep_0cedfd01e238056bb92e0733',
    'bdep_137d19c783d11e58d6df9d8d','bdep_1537cbaaf09812ea73ca07dd',
    'bdep_18947e915fb2f9f9b7cddc40','bdep_2140f2ae93465181bc79f10c',
    'bdep_493546b095ba78508acbe3b9','bdep_4a0bfb4ef7852072acc6e095',
    'bdep_4a83d5638bab4ac709e1de20','bdep_56244bebc9f0b7641d678295',
    'bdep_56779b477b85a5ed98c71809','bdep_56be3ba0e65b64b8268a7e93',
    'bdep_65e91cad46b98e707972ac28','bdep_73c0ccadc64d73016ddd20e6',
    'bdep_89dad06e408cb939d6ae3e4e','bdep_8afe2dd61f821bfb96dfb940',
    'bdep_8f17666a9ff8524ff2b8a8a8','bdep_8fc0225162071ba3152eb4f8',
    'bdep_a34791fae0e37a139e73c8cc','bdep_a9ba25e5bafff006827b969e',
    'bdep_ac52ae1d63b713d13584cf02','bdep_ba067e2735aed4f1493bb5cd',
    'bdep_bc2cfd0de0ebf5e0471317b9','bdep_c03cc220f8c4d504719f5761',
    'bdep_c8af6752e89b0940d4140809','bdep_e0187d0b0619bd7e8cdf56a5',
    'bdep_f03f86d4fece24a248515807','bdep_f9dd8ac6b5d92331d00aaa9b'
  );
  IF excluded <> 28 THEN
    RAISE EXCEPTION '0214: expected 28 excluded Bill.com deposits, found %', excluded;
  END IF;
END $$;
