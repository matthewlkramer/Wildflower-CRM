-- 0209: apply the remaining owner exclusion rulings from the reviewed
-- bank_deposits_flat.csv (owner marked 519 deposits with an exclusion reason;
-- 304 were already excluded in prod and 158 were covered by 0207 — this
-- applies the 50 still-unexcluded ones).
--
-- The file's deposit ids predate the Wells Fargo re-import, so rows were
-- re-matched to current prod deposits by (deposit_date, amount, memo); all 50
-- matched exactly one componentless, unexcluded deposit. The owner's original
-- label is preserved in the note; reasons map onto the existing enum:
--   MEMBERSHIP_FEE → membership; SERVICE_AGREEMENT / EMBRACING_EQUITY →
--   earned_income; PAYMENT_REFUND → expense_refund; PAYROLL_TAX_REFUND →
--   tax_refund; RETURN_WIRE / TOO_SMALL → other.
--
-- Idempotent: deterministic ids + ON CONFLICT DO NOTHING; guarded to skip any
-- deposit that has since gained components.
--
-- Apply after merge, by a human (prod-only data repair; no Publish needed):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0209_flat_review_owner_exclusions.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

INSERT INTO bank_deposit_exclusions (id, bank_deposit_id, reason, note, created_by_user_id)
SELECT 'bdex_' || v.dep_id, v.dep_id, v.reason, v.note, 'usr_matthew_kramer'
FROM (VALUES
  ('bdep_0c89e513d1806385030ff3b7', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_134423478f542e6a8bda1d12', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_2be4503c5f530ad1b50d2f29', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_169f16af5ea4d179ab10b21d', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_017a668d0d8b43e1dcd33e60', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_f0493b8a96cb5d8e99430e78', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_2779092e6203ce4852e26388', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_6650a21c59ae3094c212bf16', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_aef24e3ecdac20ce20401235', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_016c70890d487dee4e063773', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_0784804e1fd99f0c1c863763', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_c6fa67f0c285c5baf9de070e', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_f944a411f89be25bf101e2f7', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_65df0ddb5654b4c7f945b5ae', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_5102159cda87c83ab5b6d178', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): EMBRACING_EQUITY'),
  ('bdep_f5f26cad6ec624d43fa42fea', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_fed1cc2d2d3f1d95e4e96b5d', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): EMBRACING_EQUITY'),
  ('bdep_d681bc74df813463d31ab1a1', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_56ac204072b570a788cb67a4', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_351928ed57f00424582bd387', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_c50c183b790ace985b033a13', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_cd0bfbb092d6aa31b025fa76', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_96a1515148d724821fef4dbb', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_8300b8957aec0ff0b2beda14', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_88087b22889a8423956e8d8b', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_d6274fb3bbf79257c25b77b5', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_cfa0ec53ed713a423c648ab8', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_bc12caf4e3b020c036409ff2', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_188a79c34b016a5050307c88', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_6219625b3e1164b91ace4023', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_a59ba48599b863962e1af257', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_628facc2a68da305206218b2', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_55b87102fbb7de8001c8c671', 'other'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): RETURN_WIRE'),
  ('bdep_7f163301ebdbe5f79c413371', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_84e2064c862a7842652f9c6b', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_9743c4646d4a53fccc708bae', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_9c019cf9fd9ad1f00bae4ff7', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_394c90553cee323ee601b972', 'other'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): RETURN_WIRE'),
  ('bdep_acb8e761caa8e6b5470953fd', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_c1abd9670d3a244e33116239', 'expense_refund'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): PAYMENT_REFUND'),
  ('bdep_d785bd529fd29875949f94b1', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_dd9ff546358429b4aad34112', 'membership'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): MEMBERSHIP_FEE'),
  ('bdep_16dc6e852d5148745fffe761', 'other'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): RETURN_WIRE'),
  ('bdep_e18582e5690c2f096f48e84b', 'other'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): RETURN_WIRE'),
  ('bdep_2fa0c818f00dfd716845e97e', 'other'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): RETURN_WIRE'),
  ('bdep_79d548f06cff04d10b4250f7', 'tax_refund'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): PAYROLL_TAX_REFUND'),
  ('bdep_a6793baf1af7a8765cf8deb0', 'other'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): TOO_SMALL'),
  ('bdep_dffc28153185b4bd990e4404', 'other'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): TOO_SMALL'),
  ('bdep_c1feb15d9960fe2d534e7f77', 'other'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): TOO_SMALL'),
  ('bdep_bf7ac88dc6a7048cecb04078', 'other'::staged_payment_exclusion_reason, 'owner ruling (bank_deposits_flat review, 2026-07-27): TOO_SMALL')) AS v(dep_id, reason, note)
WHERE EXISTS (SELECT 1 FROM bank_deposits d WHERE d.id = v.dep_id)
  AND NOT EXISTS (SELECT 1 FROM bank_deposit_components b WHERE b.bank_deposit_id = v.dep_id)
ON CONFLICT (bank_deposit_id) DO NOTHING;
