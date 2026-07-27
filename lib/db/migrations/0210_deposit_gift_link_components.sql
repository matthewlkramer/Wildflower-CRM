-- 0210: single-payment components for 76 componentless deposits whose
-- full-amount QBO evidence matched an existing CRM gift (owner-reviewed
-- deposit_gift_matches_v3.csv, rulings 2026-07-27):
--   - 54 unique amount+date matches approved as-is (4 held back: two
--     same-amount collisions needing an owner call)
--   - 16 owner-chosen among ambiguous candidates
--   - 5 owner-hinted matches beyond the +/-45-day window (CSGF $20k, one8
--     $50k, Arthur Rock stock-sale tranche $252,826.60, Borealis $70k,
--     Amy Gips $10k)
--   - Omidyar/Imaginable Futures $1M wire covering both $500k gifts
--     (two components on one deposit)
-- Each gift already has exactly one payment unit (gross = deposit amount,
-- unit->gift pointer already set); only the bank component is missing.
-- Also applies the owner's 14 exclusions from the same review (12
-- EMBRACING_EQUITY + 2 WNYCS SERVICE_AGREEMENT -> earned_income).
--
-- Idempotent: deterministic ids + ON CONFLICT DO NOTHING; guarded to skip
-- deposits that have since gained components or exclusions.
--
-- Apply after merge, by a human (prod-only data repair; no Publish needed):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0210_deposit_gift_link_components.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

INSERT INTO bank_deposit_components
  (id, bank_deposit_id, payment_unit_id, amount, source, needs_review,
   classification_source)
SELECT m.cid, m.dep_id, m.unit_id, m.amt, 'manual', false, 'manual'
FROM (VALUES
  ('bdc_wb_'||md5('bdep_e458ee03c26d2575aacc090a|pu_PlV4uyXv1dP-3aTYTU8jF'), 'bdep_e458ee03c26d2575aacc090a', 'pu_PlV4uyXv1dP-3aTYTU8jF', 25000.00),
  ('bdc_wb_'||md5('bdep_eb95e53fb4a5f8da1e5826f3|pu_7_mIJ5OcsKZqjiglSSFGv'), 'bdep_eb95e53fb4a5f8da1e5826f3', 'pu_7_mIJ5OcsKZqjiglSSFGv', 250000.00),
  ('bdc_wb_'||md5('bdep_6e4c5175eef06e73838b9d38|pu_dbVY7ag4YNyIuGeWKQQYJ'), 'bdep_6e4c5175eef06e73838b9d38', 'pu_dbVY7ag4YNyIuGeWKQQYJ', 120000.00),
  ('bdc_wb_'||md5('bdep_090773a862f46f4359a878dd|pu_h5ApWWAynFlnwmTdiDFue'), 'bdep_090773a862f46f4359a878dd', 'pu_h5ApWWAynFlnwmTdiDFue', 35000.00),
  ('bdc_wb_'||md5('bdep_f9b70aa4d39f80da216b06f7|pu_MEuAqlTKG8G6UB3XI66qo'), 'bdep_f9b70aa4d39f80da216b06f7', 'pu_MEuAqlTKG8G6UB3XI66qo', 70000.00),
  ('bdc_wb_'||md5('bdep_4c68cc628f2781f63ea26a30|pu_ch_1Gun1lAhXr9x8yiRzmQpsAhS'), 'bdep_4c68cc628f2781f63ea26a30', 'pu_ch_1Gun1lAhXr9x8yiRzmQpsAhS', 500.00),
  ('bdc_wb_'||md5('bdep_9c26af6796adfbfe52368aee|pu_L0ufOo6TQIDKtcJ4LkIhm'), 'bdep_9c26af6796adfbfe52368aee', 'pu_L0ufOo6TQIDKtcJ4LkIhm', 30000.00),
  ('bdc_wb_'||md5('bdep_5907faa42485cf505c75cefb|pu_mMiYzORzVYZOregLTWAzS'), 'bdep_5907faa42485cf505c75cefb', 'pu_mMiYzORzVYZOregLTWAzS', 15000.00),
  ('bdc_wb_'||md5('bdep_370cf5d4f0eba2375b2851e8|pu_5JrFwXTVxmLSsrfNN1moX'), 'bdep_370cf5d4f0eba2375b2851e8', 'pu_5JrFwXTVxmLSsrfNN1moX', 25000.00),
  ('bdc_wb_'||md5('bdep_80e7ca9b811f3047d7736f57|pu_a68Ktw3EldcNAbemi2CLW'), 'bdep_80e7ca9b811f3047d7736f57', 'pu_a68Ktw3EldcNAbemi2CLW', 27000.00),
  ('bdc_wb_'||md5('bdep_a1d463a79b571e87f9de9efb|pu_0mKOzGROE1IgwbvfEL0-G'), 'bdep_a1d463a79b571e87f9de9efb', 'pu_0mKOzGROE1IgwbvfEL0-G', 25000.00),
  ('bdc_wb_'||md5('bdep_fc8624105146e51a795a7d02|pu_TVpSnyQjpzRlxlUTo-w1o'), 'bdep_fc8624105146e51a795a7d02', 'pu_TVpSnyQjpzRlxlUTo-w1o', 1000000.00),
  ('bdc_wb_'||md5('bdep_c891d3872e8c0aafaea233d7|pu_rSozHaSKb4zbITx_GmmzY'), 'bdep_c891d3872e8c0aafaea233d7', 'pu_rSozHaSKb4zbITx_GmmzY', 500000.00),
  ('bdc_wb_'||md5('bdep_7146e74d364947855e40ed50|pu_pvo5bpVXYf2V2CTRMc3Sm'), 'bdep_7146e74d364947855e40ed50', 'pu_pvo5bpVXYf2V2CTRMc3Sm', 95000.00),
  ('bdc_wb_'||md5('bdep_cfd8e895179b3deaa97d888c|pu_q7WsD5vYj8mu6h0DX9TVF'), 'bdep_cfd8e895179b3deaa97d888c', 'pu_q7WsD5vYj8mu6h0DX9TVF', 20000.00),
  ('bdc_wb_'||md5('bdep_fe2c3375b6a228c6acc710b2|pu_Nm6VBhWIaoIGM7I-G4xvq'), 'bdep_fe2c3375b6a228c6acc710b2', 'pu_Nm6VBhWIaoIGM7I-G4xvq', 550.00),
  ('bdc_wb_'||md5('bdep_dd28da4a25408c317afb20f8|pu_X_6mrULWFAqY1pCHcZmNc'), 'bdep_dd28da4a25408c317afb20f8', 'pu_X_6mrULWFAqY1pCHcZmNc', 105000.00),
  ('bdc_wb_'||md5('bdep_ec663185c53fd884f0c3a679|pu_BBXGBJTx8FZeEsmeIyKBg'), 'bdep_ec663185c53fd884f0c3a679', 'pu_BBXGBJTx8FZeEsmeIyKBg', 1000000.00),
  ('bdc_wb_'||md5('bdep_46e9752b5d0b7c023a63dd40|pu_fVU7cBxCXIkdYWGZ-_4JJ'), 'bdep_46e9752b5d0b7c023a63dd40', 'pu_fVU7cBxCXIkdYWGZ-_4JJ', 37500.00),
  ('bdc_wb_'||md5('bdep_cde64e2ff981414adfc15508|pu_OAjZb5c4vKVuAx_kmsRt0'), 'bdep_cde64e2ff981414adfc15508', 'pu_OAjZb5c4vKVuAx_kmsRt0', 25000.00),
  ('bdc_wb_'||md5('bdep_e18f3903fcabe49958e21942|pu_qL4-g27KC0Ulpq05sjEl0'), 'bdep_e18f3903fcabe49958e21942', 'pu_qL4-g27KC0Ulpq05sjEl0', 500000.00),
  ('bdc_wb_'||md5('bdep_4a25f10ca4d519e61db70eb3|pu_Qw0ZivqKjKDYT6JQ95Ukf'), 'bdep_4a25f10ca4d519e61db70eb3', 'pu_Qw0ZivqKjKDYT6JQ95Ukf', 500000.00),
  ('bdc_wb_'||md5('bdep_aac8ed7d585bbab4e04af6dd|pu_VBkcM3dqkdZEm_0I24UPU'), 'bdep_aac8ed7d585bbab4e04af6dd', 'pu_VBkcM3dqkdZEm_0I24UPU', 105000.00),
  ('bdc_wb_'||md5('bdep_aa9354b2db915f3a0b275f08|pu_Dv1ifFf0rl6B_S17_aI5T'), 'bdep_aa9354b2db915f3a0b275f08', 'pu_Dv1ifFf0rl6B_S17_aI5T', 722.75),
  ('bdc_wb_'||md5('bdep_6214e9a9e3ec696d3b05c177|pu_M_9ZqiSQYd04mMPHQzUEi'), 'bdep_6214e9a9e3ec696d3b05c177', 'pu_M_9ZqiSQYd04mMPHQzUEi', 15000.00),
  ('bdc_wb_'||md5('bdep_7acae4a352f7cc8e467f0a8d|pu_PO4YHOfm_RDPri1M93jBv'), 'bdep_7acae4a352f7cc8e467f0a8d', 'pu_PO4YHOfm_RDPri1M93jBv', 15000.00),
  ('bdc_wb_'||md5('bdep_18f0c5849ffcb7ac19a93300|pu_mFwhfvH-G9SWYuWpXcO8T'), 'bdep_18f0c5849ffcb7ac19a93300', 'pu_mFwhfvH-G9SWYuWpXcO8T', 250000.00),
  ('bdc_wb_'||md5('bdep_8c2a688fe0839c4ae26b59c7|pu_HOe3nfTty-i6b5tyOdX3s'), 'bdep_8c2a688fe0839c4ae26b59c7', 'pu_HOe3nfTty-i6b5tyOdX3s', 65000.00),
  ('bdc_wb_'||md5('bdep_ed5ed0c92ab68ab3b4ec2133|pu_ZfiIowHjCkf7y-UM1IUMq'), 'bdep_ed5ed0c92ab68ab3b4ec2133', 'pu_ZfiIowHjCkf7y-UM1IUMq', 249917.00),
  ('bdc_wb_'||md5('bdep_bca447ec792bbfcbcdee8143|pu_g1cIxnM07PSzjy28a2aRJ'), 'bdep_bca447ec792bbfcbcdee8143', 'pu_g1cIxnM07PSzjy28a2aRJ', 750000.00),
  ('bdc_wb_'||md5('bdep_11a91b533677ff165a06263a|pu_qrnRYsNjmpP13U4FwJzCb'), 'bdep_11a91b533677ff165a06263a', 'pu_qrnRYsNjmpP13U4FwJzCb', 7000000.00),
  ('bdc_wb_'||md5('bdep_cb546184b043999a6a9e6d24|pu_xNaaQ1XiBXZr_emnSoXmd'), 'bdep_cb546184b043999a6a9e6d24', 'pu_xNaaQ1XiBXZr_emnSoXmd', 500000.00),
  ('bdc_wb_'||md5('bdep_f30ed58a06d7b5a616e8db83|pu_AkvrooAk4pfsKl1lKWKvz'), 'bdep_f30ed58a06d7b5a616e8db83', 'pu_AkvrooAk4pfsKl1lKWKvz', 25000.00),
  ('bdc_wb_'||md5('bdep_c61c1289ab7d0caf81ff51b2|pu_oBt6jAoLrjeCovNYwtX2A'), 'bdep_c61c1289ab7d0caf81ff51b2', 'pu_oBt6jAoLrjeCovNYwtX2A', 500.00),
  ('bdc_wb_'||md5('bdep_6e4d66f8faf93650b26c65de|pu_-TYmx2sVA3RBbtO0fXB97'), 'bdep_6e4d66f8faf93650b26c65de', 'pu_-TYmx2sVA3RBbtO0fXB97', 500000.00),
  ('bdc_wb_'||md5('bdep_b559ca21d746f03f55c6bd0e|pu_8PFJYpUGgRBuwq7sgQyj9'), 'bdep_b559ca21d746f03f55c6bd0e', 'pu_8PFJYpUGgRBuwq7sgQyj9', 300000.00),
  ('bdc_wb_'||md5('bdep_b6afb0a5267eac633b2c8486|pu_i9nY0GFAjF76PpdSAqbxS'), 'bdep_b6afb0a5267eac633b2c8486', 'pu_i9nY0GFAjF76PpdSAqbxS', 7712.50),
  ('bdc_wb_'||md5('bdep_a51f7850d3147fdb48d1f8fa|pu_1GmL1g2X2K4w5q3vPBGnp'), 'bdep_a51f7850d3147fdb48d1f8fa', 'pu_1GmL1g2X2K4w5q3vPBGnp', 30000.00),
  ('bdc_wb_'||md5('bdep_b11cb74ea416888c8001dc60|pu_a0BRZPHlxfgrW1Z0_sRis'), 'bdep_b11cb74ea416888c8001dc60', 'pu_a0BRZPHlxfgrW1Z0_sRis', 8578.61),
  ('bdc_wb_'||md5('bdep_2348d297f84cd25e856d675e|pu_e5C161_bBEZu6pQa5CgAs'), 'bdep_2348d297f84cd25e856d675e', 'pu_e5C161_bBEZu6pQa5CgAs', 10000.00),
  ('bdc_wb_'||md5('bdep_2b33a09c175ce5199904380b|pu_C2axWkq5z6q1rEKhUtop1'), 'bdep_2b33a09c175ce5199904380b', 'pu_C2axWkq5z6q1rEKhUtop1', 35000.00),
  ('bdc_wb_'||md5('bdep_622473c694948ef036eec7ff|pu_3PsFWw2bDOiHQjvzLL-pi'), 'bdep_622473c694948ef036eec7ff', 'pu_3PsFWw2bDOiHQjvzLL-pi', 45000.00),
  ('bdc_wb_'||md5('bdep_daeff7830ca03b66c25e6bd3|pu_R_UzLF7gy0kWMSU7tA_EW'), 'bdep_daeff7830ca03b66c25e6bd3', 'pu_R_UzLF7gy0kWMSU7tA_EW', 10000.00),
  ('bdc_wb_'||md5('bdep_71e3a5c176814261dc4c9f4e|pu_9rgocya5OG4IsK5AsHbJR'), 'bdep_71e3a5c176814261dc4c9f4e', 'pu_9rgocya5OG4IsK5AsHbJR', 17750.00),
  ('bdc_wb_'||md5('bdep_f78d370ea7cbb0a2577c86e7|pu_nqdyPSnhsNr9j61aNoXh-'), 'bdep_f78d370ea7cbb0a2577c86e7', 'pu_nqdyPSnhsNr9j61aNoXh-', 40000.00),
  ('bdc_wb_'||md5('bdep_c43cba17970b3abb16232126|pu_2RHAoIbYk_iJDtoQAKdoR'), 'bdep_c43cba17970b3abb16232126', 'pu_2RHAoIbYk_iJDtoQAKdoR', 200000.00),
  ('bdc_wb_'||md5('bdep_5fb26266d4e32da1eb08ab09|pu_lZK_zXc98htRrrGN21VKv'), 'bdep_5fb26266d4e32da1eb08ab09', 'pu_lZK_zXc98htRrrGN21VKv', 25000.00),
  ('bdc_wb_'||md5('bdep_e434c0bb00d29cae333ecd06|pu_1upKT2_QKIYjez6ewmnZ0'), 'bdep_e434c0bb00d29cae333ecd06', 'pu_1upKT2_QKIYjez6ewmnZ0', 500000.00),
  ('bdc_wb_'||md5('bdep_6ae72bb4d1f003f68fa95bc7|pu_5OynQ8avFpIJIV4KOmfIj'), 'bdep_6ae72bb4d1f003f68fa95bc7', 'pu_5OynQ8avFpIJIV4KOmfIj', 6780.00),
  ('bdc_wb_'||md5('bdep_397153180986d97a9aaec4fd|pu_3mhT9Rz7y7SmeLbmLd0TF'), 'bdep_397153180986d97a9aaec4fd', 'pu_3mhT9Rz7y7SmeLbmLd0TF', 10000.00),
  ('bdc_wb_'||md5('bdep_56daa9df0502cb3f2f44fca4|pu_HSBT9fWf-EUtrOgnGEd8k'), 'bdep_56daa9df0502cb3f2f44fca4', 'pu_HSBT9fWf-EUtrOgnGEd8k', 100000.00),
  ('bdc_wb_'||md5('bdep_f7c7070d99e2dd9afc0a80b9|pu_ohcUoutR0l1f2VC2FXsv8'), 'bdep_f7c7070d99e2dd9afc0a80b9', 'pu_ohcUoutR0l1f2VC2FXsv8', 15000.00),
  ('bdc_wb_'||md5('bdep_7ab850499b4ff9d5289bab66|pu_WAE0WXz176NOEQxv6WPu1'), 'bdep_7ab850499b4ff9d5289bab66', 'pu_WAE0WXz176NOEQxv6WPu1', 1500000.00),
  ('bdc_wb_'||md5('bdep_f4a28992e648b7397236af80|pu_aBkPvSnFg_GUQXbkeFS4S'), 'bdep_f4a28992e648b7397236af80', 'pu_aBkPvSnFg_GUQXbkeFS4S', 3000.00),
  ('bdc_wb_'||md5('bdep_b2f017d2aca59b1901c77ff9|pu_AeQwRrtMaGTrKe6y9VJTH'), 'bdep_b2f017d2aca59b1901c77ff9', 'pu_AeQwRrtMaGTrKe6y9VJTH', 1000000.00),
  ('bdc_wb_'||md5('bdep_9292f9cf8065f70f5b0350c5|pu_OS7kH0M-F31iblgXvJVCK'), 'bdep_9292f9cf8065f70f5b0350c5', 'pu_OS7kH0M-F31iblgXvJVCK', 5000.00),
  ('bdc_wb_'||md5('bdep_b8f3700507e8fa655f7ea17a|pu__b0H7WP4sZ6yF0WOu7Nl7'), 'bdep_b8f3700507e8fa655f7ea17a', 'pu__b0H7WP4sZ6yF0WOu7Nl7', 500.00),
  ('bdc_wb_'||md5('bdep_38f138e83af6d91678a1a1f0|pu_CSOk9mw_YBwXJ9a3yXtZ-'), 'bdep_38f138e83af6d91678a1a1f0', 'pu_CSOk9mw_YBwXJ9a3yXtZ-', 50000.00),
  ('bdc_wb_'||md5('bdep_d92d3ec11839f061a6ed8e2e|pu_UbVJtm3GIDFtNzijGGtF4'), 'bdep_d92d3ec11839f061a6ed8e2e', 'pu_UbVJtm3GIDFtNzijGGtF4', 100000.00),
  ('bdc_wb_'||md5('bdep_f1a570d0c38cfe2965771cec|pu_8UbfI2julpGcYcEflFVwa'), 'bdep_f1a570d0c38cfe2965771cec', 'pu_8UbfI2julpGcYcEflFVwa', 100000.00),
  ('bdc_wb_'||md5('bdep_327136a53ac34dc450f5db36|pu_JMqUUwKS61mtEZbUrz6pS'), 'bdep_327136a53ac34dc450f5db36', 'pu_JMqUUwKS61mtEZbUrz6pS', 10000.00),
  ('bdc_wb_'||md5('bdep_26ce0c4a201c70b930226ce6|pu_xEEmwUCcYrc6Mu8-cceLB'), 'bdep_26ce0c4a201c70b930226ce6', 'pu_xEEmwUCcYrc6Mu8-cceLB', 30000.00),
  ('bdc_wb_'||md5('bdep_290d8d358ab7832f2fb8323d|pu_5siZnsfj7qHX9TgnOZ0u_'), 'bdep_290d8d358ab7832f2fb8323d', 'pu_5siZnsfj7qHX9TgnOZ0u_', 5000.00),
  ('bdc_wb_'||md5('bdep_a49a04c04ab15f6155792bb9|pu_7vfvZtvLSa3Io9WwteFJM'), 'bdep_a49a04c04ab15f6155792bb9', 'pu_7vfvZtvLSa3Io9WwteFJM', 50000.00),
  ('bdc_wb_'||md5('bdep_2b0a2fc5b874bebd922d0889|pu_2-7De7_Fs893M1CcgjWrj'), 'bdep_2b0a2fc5b874bebd922d0889', 'pu_2-7De7_Fs893M1CcgjWrj', 5000.00),
  ('bdc_wb_'||md5('bdep_8439ede2d613b23658f44ea3|pu_OC7XuzDydJOACe0Ma9stv'), 'bdep_8439ede2d613b23658f44ea3', 'pu_OC7XuzDydJOACe0Ma9stv', 60000.00),
  ('bdc_wb_'||md5('bdep_f8b265ccc01dbb3ac8307818|pu_-REYTa0_D4bWXV-LsX-dM'), 'bdep_f8b265ccc01dbb3ac8307818', 'pu_-REYTa0_D4bWXV-LsX-dM', 5000.00),
  ('bdc_wb_'||md5('bdep_aaa4491a1225fc99d84e7fda|pu_3aSAp_mvVLIzzao7D1aJf'), 'bdep_aaa4491a1225fc99d84e7fda', 'pu_3aSAp_mvVLIzzao7D1aJf', 250.00),
  ('bdc_wb_'||md5('bdep_e1cd57feae2deb786f48b1f3|pu_iE6vQk1H-VHAsCnlMil8P'), 'bdep_e1cd57feae2deb786f48b1f3', 'pu_iE6vQk1H-VHAsCnlMil8P', 5000.00),
  ('bdc_wb_'||md5('bdep_d744ee1a6627013c57432266|pu_y3iEVYFAykhYVNAKH7Ngd'), 'bdep_d744ee1a6627013c57432266', 'pu_y3iEVYFAykhYVNAKH7Ngd', 5000.00),
  ('bdc_wb_'||md5('bdep_c778c043bdb82a8afcc2acc1|pu_MzHdWZazQDotXtgsvclqR'), 'bdep_c778c043bdb82a8afcc2acc1', 'pu_MzHdWZazQDotXtgsvclqR', 20000.00),
  ('bdc_wb_'||md5('bdep_b5beaa86cf20e9a65a490072|pu_DNlJfSh-O1dw1Y2eljkK_'), 'bdep_b5beaa86cf20e9a65a490072', 'pu_DNlJfSh-O1dw1Y2eljkK_', 50000.00),
  ('bdc_wb_'||md5('bdep_be9eadb47d1b30144192f955|pu_reBsWiKqGNe95r7_Px4Cv'), 'bdep_be9eadb47d1b30144192f955', 'pu_reBsWiKqGNe95r7_Px4Cv', 252826.60),
  ('bdc_wb_'||md5('bdep_6b18e9bb3df9ede0ef6ab7aa|pu_z95MMEXudtixlTfuS_rZa'), 'bdep_6b18e9bb3df9ede0ef6ab7aa', 'pu_z95MMEXudtixlTfuS_rZa', 70000.00),
  ('bdc_wb_'||md5('bdep_c5ac3659efc3e18a5752b04e|pu_TsktxgFdT8YGVznz3lBon'), 'bdep_c5ac3659efc3e18a5752b04e', 'pu_TsktxgFdT8YGVznz3lBon', 10000.00),
  ('bdc_wb_'||md5('bdep_0a6cd7f2f38bcfe0e7dc57d7|pu_4Jn9XEMRrTWvBKKRiMU4f:split:1'), 'bdep_0a6cd7f2f38bcfe0e7dc57d7', 'pu_4Jn9XEMRrTWvBKKRiMU4f:split:1', 500000.00),
  ('bdc_wb_'||md5('bdep_0a6cd7f2f38bcfe0e7dc57d7|pu_4Jn9XEMRrTWvBKKRiMU4f:split:2'), 'bdep_0a6cd7f2f38bcfe0e7dc57d7', 'pu_4Jn9XEMRrTWvBKKRiMU4f:split:2', 500000.00)) AS m(cid, dep_id, unit_id, amt)
WHERE EXISTS (SELECT 1 FROM bank_deposits d WHERE d.id = m.dep_id)
  AND EXISTS (SELECT 1 FROM payment_units u WHERE u.id = m.unit_id)
  AND NOT EXISTS (SELECT 1 FROM bank_deposit_components b
                  WHERE b.bank_deposit_id = m.dep_id)
  AND NOT EXISTS (SELECT 1 FROM bank_deposit_components b
                  WHERE b.payment_unit_id = m.unit_id)
  AND NOT EXISTS (SELECT 1 FROM bank_deposit_exclusions e
                  WHERE e.bank_deposit_id = m.dep_id)
ON CONFLICT (id) DO NOTHING;

-- Owner exclusions from the same review.
INSERT INTO bank_deposit_exclusions (id, bank_deposit_id, reason, note, created_by_user_id)
SELECT 'bdex_' || v.dep_id, v.dep_id, v.reason, v.note, 'usr_matthew_kramer'
FROM (VALUES
  ('bdep_5576239d6ef8b3dc53cfdf86', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (gift-match review, 2026-07-27): EMBRACING_EQUITY'),
  ('bdep_8bad03ac63fc0f9ac36b8dfb', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (gift-match review, 2026-07-27): EMBRACING_EQUITY'),
  ('bdep_94da025ae3461eea627cf103', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (gift-match review, 2026-07-27): EMBRACING_EQUITY'),
  ('bdep_56648a59fee274de9ed07cf1', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (gift-match review, 2026-07-27): EMBRACING_EQUITY'),
  ('bdep_b1fc3bdc02ae18bea6aa05d3', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (gift-match review, 2026-07-27): EMBRACING_EQUITY'),
  ('bdep_8289fd817caef1e45b8e59bd', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (gift-match review, 2026-07-27): EMBRACING_EQUITY'),
  ('bdep_b90a149c40c8d119d2e37999', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (gift-match review, 2026-07-27): EMBRACING_EQUITY'),
  ('bdep_ceef53b3b532d5f83067bb37', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (gift-match review, 2026-07-27): EMBRACING_EQUITY'),
  ('bdep_8213f159a1de1a0508405e66', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (gift-match review, 2026-07-27): EMBRACING_EQUITY'),
  ('bdep_bffb35a477c4370b453ea9ba', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (gift-match review, 2026-07-27): EMBRACING_EQUITY'),
  ('bdep_7faa774b54a51ccb7be6ed4b', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (gift-match review, 2026-07-27): EMBRACING_EQUITY'),
  ('bdep_64d57f82e2c39daca1037bcb', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (gift-match review, 2026-07-27): EMBRACING_EQUITY'),
  ('bdep_f8f8e9d0d7e3128f2597aae4', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (gift-match review, 2026-07-27): SERVICE_AGREEMENT'),
  ('bdep_e84eabbf6a6279ab41529e6a', 'earned_income'::staged_payment_exclusion_reason, 'owner ruling (gift-match review, 2026-07-27): SERVICE_AGREEMENT')
) AS v(dep_id, reason, note)
WHERE EXISTS (SELECT 1 FROM bank_deposits d WHERE d.id = v.dep_id)
  AND NOT EXISTS (SELECT 1 FROM bank_deposit_components b WHERE b.bank_deposit_id = v.dep_id)
ON CONFLICT (bank_deposit_id) DO NOTHING;

-- Post-conditions: every componented deposit's components sum to its amount,
-- and every component's unit points at a gift.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT d.id, d.amount, sum(b.amount) comp_sum
    FROM (SELECT DISTINCT bank_deposit_id
          FROM bank_deposit_components WHERE id LIKE 'bdc_wb_%') t
    JOIN bank_deposits d ON d.id = t.bank_deposit_id
    JOIN bank_deposit_components b ON b.bank_deposit_id = d.id
    GROUP BY d.id, d.amount
  LOOP
    IF r.comp_sum <> r.amount THEN
      RAISE EXCEPTION '0210: % components sum to % (expected %)', r.id, r.comp_sum, r.amount;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM bank_deposit_components b
             JOIN payment_units u ON u.id = b.payment_unit_id
             WHERE b.id LIKE 'bdc_wb_%' AND u.gift_id IS NULL) THEN
    RAISE EXCEPTION '0210: component created for a unit without a gift pointer';
  END IF;
END $$;
