-- 0186: reverse the erroneous deposit-level exclusions for CSP grant pledge
-- receipts and the CSGF loan.
--
-- These 32 Wells Fargo deposits were previously classified as
-- intercompany_transfer (31 CSP -> Operating receipts) or loan (the
-- $150,000 "Loan from CSGF"). The CSP pledge originals land in a separate
-- Bremer account that is not present in this Wells Fargo feed, so the
-- CSP -> Operating inflows are the real receipts rather than double-counted
-- transfers. The owner explicitly confirmed that all 32 exclusions should be
-- reversed. This deliberately does not include the separate $20 Gusto payroll
-- refund that happened to contain "csp" in a token.
--
-- One-time, human-gated data correction; this is idempotent because a rerun
-- simply finds no remaining rows for already-deleted exclusions.
--
-- Apply only after review, to both environments:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0186_reverse_csp_csgf_exclusions.sql
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0186_reverse_csp_csgf_exclusions.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

DELETE FROM bank_deposit_exclusions
WHERE bank_deposit_id IN (
  'bdep_d78dc03e64788031cc4edad8',
  'bdep_89f32620ae36786b3b2f6f49',
  'bdep_1e7808d2d64a202cd3296ffa',
  'bdep_9f3fbbb38164674f0ef7955b',
  'bdep_b3b8d4e1a7406e8142b0f6e4',
  'bdep_c29be282d42555e0074741cf',
  'bdep_cae75f0f58f957ba48944e04',
  'bdep_0501311e25593970b7f5028b',
  'bdep_8fd0db57e00f6cd6781da8b2',
  'bdep_10bd30e844eeb03778954a83',
  'bdep_6d30ae8cf4fe46cba4b7c532',
  'bdep_280bbccf14dfcbbcd9399525',
  'bdep_2e0ecc5651ab4e865d564d9b',
  'bdep_c94c2199c0afc84006e16865',
  'bdep_f8eb50b50de2927115bc7771',
  'bdep_ae869e1cc3d546a7955990e6',
  'bdep_a6a9247cf8d08d55e667fa26',
  'bdep_f927e42f74c8493ab49aa9fa',
  'bdep_e859f5ddf564893bf7ab7ce0',
  'bdep_d3299e8e2422ca1751a7fe7d',
  'bdep_4cc791b4fcf7e7f64ba05ff5',
  'bdep_1f15ed266fa531c05e97b4df',
  'bdep_3b84602205ad94a455470d35',
  'bdep_09af0fb19a172c64a9b15fcd',
  'bdep_b54cd9c212c8672c8a1abfd5',
  'bdep_b62cf9d0689a8dec7e70f6a5',
  'bdep_7a533aebcf9616bf240b57fa',
  'bdep_82e8d826bbcc504453056403',
  'bdep_8f46409373edd73fa1e5936a',
  'bdep_039ce25b2ee452bb9c283a30',
  'bdep_7cb6ae97c095b89b0595ff94',
  'bdep_83a70b01417b63606a9728a0'
);

SELECT count(*) AS remaining_target_exclusions
FROM bank_deposit_exclusions
WHERE bank_deposit_id IN (
  'bdep_d78dc03e64788031cc4edad8',
  'bdep_89f32620ae36786b3b2f6f49',
  'bdep_1e7808d2d64a202cd3296ffa',
  'bdep_9f3fbbb38164674f0ef7955b',
  'bdep_b3b8d4e1a7406e8142b0f6e4',
  'bdep_c29be282d42555e0074741cf',
  'bdep_cae75f0f58f957ba48944e04',
  'bdep_0501311e25593970b7f5028b',
  'bdep_8fd0db57e00f6cd6781da8b2',
  'bdep_10bd30e844eeb03778954a83',
  'bdep_6d30ae8cf4fe46cba4b7c532',
  'bdep_280bbccf14dfcbbcd9399525',
  'bdep_2e0ecc5651ab4e865d564d9b',
  'bdep_c94c2199c0afc84006e16865',
  'bdep_f8eb50b50de2927115bc7771',
  'bdep_ae869e1cc3d546a7955990e6',
  'bdep_a6a9247cf8d08d55e667fa26',
  'bdep_f927e42f74c8493ab49aa9fa',
  'bdep_e859f5ddf564893bf7ab7ce0',
  'bdep_d3299e8e2422ca1751a7fe7d',
  'bdep_4cc791b4fcf7e7f64ba05ff5',
  'bdep_1f15ed266fa531c05e97b4df',
  'bdep_3b84602205ad94a455470d35',
  'bdep_09af0fb19a172c64a9b15fcd',
  'bdep_b54cd9c212c8672c8a1abfd5',
  'bdep_b62cf9d0689a8dec7e70f6a5',
  'bdep_7a533aebcf9616bf240b57fa',
  'bdep_82e8d826bbcc504453056403',
  'bdep_8f46409373edd73fa1e5936a',
  'bdep_039ce25b2ee452bb9c283a30',
  'bdep_7cb6ae97c095b89b0595ff94',
  'bdep_83a70b01417b63606a9728a0'
);
