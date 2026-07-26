# Machine-derived state review package

This package is the deterministic mirror of artifacts/api-server/src/lib/bankSpineRecompute.ts, computed read-only from PROD_DATABASE_URL_READONLY on 2026-07-26. No recompute, INSERT, UPDATE, DELETE, or migration was run against production.

The computation uses bank-native deduplication for bank_csv_export rows. Identity is (txn_date, coalesce(ref_no, empty), memo, coalesce(payment, empty), coalesce(deposit, empty)). Each identity group collapses to one canonical row, choosing enrichment by non-empty payee, then qb_posting, then donor, then id. Canonical IDs use the recompute SHA-256 derivation with occurrence 0.

## Counts and dollars

| Table/output | Production rows | Production dollars | Machine rows | Machine dollars |
|---|---:|---:|---:|---:|
| bank_transactions | 2074 | 91089645.81 | 2001 | 86202075.61 |
| bank_deposits | 1680 | 91089645.81 | 1607 | 86202075.61 |
| payment_units | 994 | 80601301.74 | 510 | 30414246.43 |
| bank_deposit_components | 187 | 32624834.90 | 180 | 28287834.90 |
| stripe_payout_ties | 161 | 97278.55 | 161 | 97278.55 |
| qbo_register_links | 451 | 27100046.63 | 449 | 26842926.43 |

Raw bank_transactions source rows: 2074. Canonical rows: 2001. Positive bank deposits change from 1680 production rows to 1607 machine rows.
Duplicate collapse removed 73 rows across 62 identity groups.
Machine payment_units contain 284 Stripe charge units and 226 full step-4a QBO composition units across all CASE-derived kinds. The approximately 360 attribution-support kind=other units without qb_deposit_id from migration 0178 are intentionally absent; those units return only when human attribution decisions are reapplied.

## Deduped bank rows removed

The complete list of collapsed rows is in id_remap.csv. The following rows were removed from the canonical bank input:
- 2021-01-08 | deposit 81000.00 | ATM CHECK DEPOSIT              ON              01/08 1505 WEST LAKE ST         Minneapolis   MN  0002674           ATM ID 6991J    CARD 7365 | bnk_599fc6dece1d0e8fb1595bd0 → bnk_196f52f4b39696da97af9347
- 2021-01-08 | deposit 81000.00 | ATM CHECK DEPOSIT              ON              01/08 1505 WEST LAKE ST         Minneapolis   MN  0002674           ATM ID 6991J    CARD 7365 | bnk_a9a2b1d0172360ec16ba9450 → bnk_196f52f4b39696da97af9347
- 2019-12-10 | deposit 55000.00 | ATM CHECK DEPOSIT              ON              12/10 1505 WEST LAKE ST         MINNEAPOLIS   MN  0003801           ATM ID 6991J    CARD 7365 | bnk_abdacbfaeb9e8c4675310f6c → bnk_b03d4187a60aef6417e84e51
- 2022-11-14 | deposit 344110.13 | ATM CHECK DEPOSIT              ON              11/14 3453 Nicollet Ave S       Minneapolis   MN  0003688           ATM ID 5839C    CARD 7365 | bnk_6b6bd75e8acdd832ea1ef86c → bnk_c412b3b0d004fe23f8fe5747
- 2022-11-14 | deposit 344110.13 | ATM CHECK DEPOSIT              ON              11/14 3453 Nicollet Ave S       Minneapolis   MN  0003688           ATM ID 5839C    CARD 7365 | bnk_bc66a208e66c6f5d12e2dcfb → bnk_c412b3b0d004fe23f8fe5747
- 2021-04-15 | deposit 6497.50 | ATM CHECK DEPOSIT              ON              04/15 4712 CHICAGO AVE S        Minneapolis   MN  0001096           ATM ID 5819T    CARD 7365 | bnk_8b30bdfd3f913fcf49431f67 → bnk_8600715be8d175a6b6291084
- 2021-04-15 | deposit 6497.50 | ATM CHECK DEPOSIT              ON              04/15 4712 CHICAGO AVE S        Minneapolis   MN  0001096           ATM ID 5819T    CARD 7365 | bnk_b8fc2166c4fe25173dd3a769 → bnk_8600715be8d175a6b6291084
- 2021-01-29 | deposit 62800.00 | ATM CHECK DEPOSIT              ON              01/29 1505 WEST LAKE ST         Minneapolis   MN  0005858           ATM ID 6991J    CARD 7365 | bnk_c17aa17ca129c9060f2fa306 → bnk_9ec0dcc3098b830474d2bf93
- 2018-01-08 | deposit 101575.18 | ATM CHECK DEPOSIT 01/08 4712 CHICAGO AVE S MINNEAPOLIS MN 5819T 7365 | bnk_4d0305f68b0aacb7bf9ec285 → bnk_c6e583e254dd6fd2894718ef
- 2017-05-05 | deposit 15.00 | PARTIAL WIRE TRANS SVC CHARGE REVERSAL | bnk_e54452211ce40736510af9a0 → bnk_3be45b6dbe250adac337908a
- 2020-02-11 | deposit 5500.00 | ATM CHECK DEPOSIT              ON              02/11 3030 NICOLLET AVE         MINNEAPOLIS   MN  0005767           ATM ID 5813V    CARD 7365 | bnk_1a8c5dbaeb815467edd479a5 → bnk_86fd6567e35737d37794e8d7
- 2021-12-13 | deposit 315709.30 | ATM CHECK DEPOSIT              ON              12/13 1505 W Lake St            Minneapolis   MN  0009523           ATM ID 6991J    CARD 7365 | bnk_23c4f4e92f5b3eb8bd064a06 → bnk_14ddd1a2e9ff3ab974d015d7
- 2021-12-13 | deposit 315709.30 | ATM CHECK DEPOSIT              ON              12/13 1505 W Lake St            Minneapolis   MN  0009523           ATM ID 6991J    CARD 7365 | bnk_b7b2594c80660b15b990248f → bnk_14ddd1a2e9ff3ab974d015d7
- 2023-03-20 | deposit 100016.18 | ATM CHECK DEPOSIT              ON              03/20 1505 W Lake St            Minneapolis   MN  0008675           ATM ID 6991J    CARD 7365 | bnk_9977687fcc92fb3d2ef169c7 → bnk_7da7a70504ce9d3677fe6102
- 2019-07-30 | deposit 5200.00 | eDeposit in Branch/Store 07/30/19 02:30:25 PM 1505 W LAKE ST MINNEAPOLIS MN 8945 | bnk_dd4d622411d1f764c99948c1 → bnk_f7c2be98c5d8c9994c2bf409
- 2024-05-30 | deposit 57964.92 | DEPOSIT | bnk_88a0278d383df60e747537f1 → bnk_06f6b197da08b4e2a119b059
- 2018-09-21 | deposit 8500.00 | ATM CHECK DEPOSIT 09/21 3030 NICOLLET AVE MINNEAPOLIS MN 5813V 7365 | bnk_a9cac3bc5c26826df3923f46 → bnk_be018b05baf9bfa383f05d51
- 2021-05-13 | deposit 6250.00 | eDeposit in Branch/Store 05/13/21 03:18:08 PM 7900 XERXES AVE S BLOOMINGTON MN | bnk_db945f745ee24fa174c5bbd1 → bnk_a82ed89caa590f48df1854c9
- 2021-01-26 | deposit 324514.00 | ATM CHECK DEPOSIT              ON              01/26 1505 WEST LAKE ST         Minneapolis   MN  0005487           ATM ID 6991J    CARD 7365 | bnk_173d1ddec56031b048950091 → bnk_f2a2f5485711ff7434d4895f
- 2020-10-29 | deposit 7590.00 | ATM CHECK DEPOSIT              ON              10/29 1505 WEST LAKE ST         Minneapolis   MN  0004527           ATM ID 6991J    CARD 7365 | bnk_aa4819978b53db272f8e4f67 → bnk_dd3cea3bd8ed27b9ed358333
- 2019-02-04 | deposit 31794.00 | ATM CHECK DEPOSIT              ON              02/04 4712 CHICAGO AVE S        MINNEAPOLIS   MN  0009384           ATM ID 5819T    CARD 7365 | bnk_67051bc69281df55011d6068 → bnk_a296e7b89ac0b1ee89ae45ac
- 2025-04-10 | deposit 8413.12 | Minnesota Wildfl Receivable        016UCVPQT3P4T09 016UCVPQT3P4T09 Minnesota Wildfl Bill.com Multip | bnk_83c856c1471ebab9f1e28902 → bnk_a1a2e5ea6d0e96b9655c81b5
- 2019-12-17 | deposit 192015.14 | ATM CHECK DEPOSIT              ON              12/17 1505 WEST LAKE ST         MINNEAPOLIS   MN  0004482           ATM ID 6991J    CARD 7365 | bnk_e1ef02c866f2164bb8ef0e2e → bnk_2c74caddf50635edb039b188
- 2018-11-21 | deposit 4974.50 | ATM CHECK DEPOSIT              ON              11/21 1505 WEST LAKE ST         MINNEAPOLIS   MN  0004752           ATM ID 6991J    CARD 7365 201811212 | bnk_87eb7fb622f5f7023a490620 → bnk_5781fedf01d4968b8679504d
- 2018-11-21 | deposit 4974.50 | ATM CHECK DEPOSIT              ON              11/21 1505 WEST LAKE ST         MINNEAPOLIS   MN  0004752           ATM ID 6991J    CARD 7365 201811212 | bnk_6405c4fc8d953b81dd5ecaf2 → bnk_5781fedf01d4968b8679504d
- 2019-01-08 | deposit 51794.00 | ATM CHECK DEPOSIT              ON              01/08 1505 WEST LAKE ST         MINNEAPOLIS   MN  0000214           ATM ID 6991J    CARD 7365 | bnk_8b92efc7a422555e61f790d8 → bnk_b192a069c49d8ff4e32c3669
- 2020-01-14 | deposit 25532.94 | ATM CHECK DEPOSIT              ON              01/14 1505 WEST LAKE ST         MINNEAPOLIS   MN  0007155           ATM ID 6991J    CARD 7365 | bnk_2bec3f294d4841f0b260eead → bnk_e3b13b26defa0f74ce65f79b
- 2022-03-30 | deposit 30250.00 | ATM CHECK DEPOSIT              ON              03/30 4712 Chicago Ave          Minneapolis   MN  0002046           ATM ID 5819T    CARD 7365 | bnk_2be46155060ba60d7edeb4d9 → bnk_572731d92b4d55e99d1b35b4
- 2022-03-30 | deposit 30250.00 | ATM CHECK DEPOSIT              ON              03/30 4712 Chicago Ave          Minneapolis   MN  0002046           ATM ID 5819T    CARD 7365 | bnk_ffba554213f67aa6f36573cb → bnk_572731d92b4d55e99d1b35b4
- 2023-07-13 | deposit 20485.38 | ATM CHECK DEPOSIT              ON              07/13 4712 Chicago Ave          Minneapolis   MN  0003379           ATM ID 5819T    CARD 7365 | bnk_2b184d9b150c87c22cb8745b → bnk_69cfdd4cc901563353638890
- 2020-07-17 | deposit 45121.60 | ATM CHECK DEPOSIT              ON              07/17 1505 WEST LAKE ST         Minneapolis   MN  0004409           ATM ID 6991J    CARD 7365 | bnk_78f87540b0be4a13b2dc2c9c → bnk_525fe82d26cefd5e19547527
- 2020-07-17 | deposit 45121.60 | ATM CHECK DEPOSIT              ON              07/17 1505 WEST LAKE ST         Minneapolis   MN  0004409           ATM ID 6991J    CARD 7365 | bnk_a11c6ba0de1fbc86e7463a97 → bnk_525fe82d26cefd5e19547527
- 2019-04-11 | deposit 2893.84 | ATM CHECK DEPOSIT              ON              04/11 1505 WEST LAKE ST         MINNEAPOLIS   MN  0009929           ATM ID 6991J    CARD 7365 | bnk_7e2fa264fb1d516e3be36938 → bnk_54f2e5551843b64fea73218a
- 2020-06-25 | deposit 75625.00 | ATM CHECK DEPOSIT              ON              06/25 1505 WEST LAKE ST         Minneapolis   MN  0007695           ATM ID 6991J    CARD 7365 | bnk_7d5861ddec7707c88b1e4db1 → bnk_b3e0f5c6dc1983ab398ff019
- 2022-01-27 | deposit 28223.34 | ATM CHECK DEPOSIT              ON              01/27 1505 W Lake St            Minneapolis   MN  0005612           ATM ID 6991J    CARD 7365 | bnk_395f6cf932d9fc58678bf0d2 → bnk_63badd1ebf7cdf1b7536dfff
- 2022-04-15 | deposit 295602.69 | ATM CHECK DEPOSIT              ON              04/15 7900 Xerxes Ave S Ste 201 Bloomington   MN  0005914           ATM ID 5829A    CARD 7365 | bnk_e4b007203578cd6f7120379c → bnk_322d9deffea70b39fb114c32
- 2022-04-15 | deposit 295602.69 | ATM CHECK DEPOSIT              ON              04/15 7900 Xerxes Ave S Ste 201 Bloomington   MN  0005914           ATM ID 5829A    CARD 7365 | bnk_3c5c3ca8ab940c6d232227bf → bnk_322d9deffea70b39fb114c32
- 2018-08-08 | deposit 67900.00 | ATM CHECK DEPOSIT 08/08 3030 NICOLLET AVE MINNEAPOLIS MN 5813V 7365 | bnk_3dc90e0adcfd183262ce12f6 → bnk_c9990755417751ad8c5d32a1
- 2023-04-21 | deposit 27290.98 | ATM CHECK DEPOSIT              ON              04/21 1505 W Lake St            Minneapolis   MN  0004090           ATM ID 6993M    CARD 7365 | bnk_5bd82a707b02ec1f620d558b → bnk_621b2f41c217cc9e02ba32cb
- 2019-03-06 | deposit 10514.50 | ATM CHECK DEPOSIT              ON              03/06 1505 WEST LAKE ST         MINNEAPOLIS   MN  0006186           ATM ID 6991J    CARD 7365 | bnk_94b8749bcd92cda2ecf56702 → bnk_9b132b49c8edf6d23308f21b
- 2019-03-06 | deposit 10514.50 | ATM CHECK DEPOSIT              ON              03/06 1505 WEST LAKE ST         MINNEAPOLIS   MN  0006186           ATM ID 6991J    CARD 7365 | bnk_efe6752718d54071e5169081 → bnk_9b132b49c8edf6d23308f21b
- 2022-02-28 | deposit 75000.00 | ATM CHECK DEPOSIT              ON              02/28 1505 W Lake St            Minneapolis   MN  0001481           ATM ID 6991L    CARD 7365 | bnk_d3d0a4b86939f8f21be45f5e → bnk_695a25831e86e67e37789e52
- 2022-05-31 | deposit 2076.66 | STRIPE           TRANSFER          ST-G7K5C0A9F7K4 THE WILDFLOWER FOUNDAT | bnk_c4960da1f391c7fb247828a2 → bnk_d3108722bc82ad57c22edf2d
- 2020-06-11 | deposit 7020.00 | ATM CHECK DEPOSIT              ON              06/11 1505 WEST LAKE ST         MINNEAPOLIS   MN  0004093           ATM ID 6991J    CARD 7365 | bnk_5658f1fec97479d7dd5c1b83 → bnk_cf41141e487a9570d22a0e1e
- 2021-07-15 | deposit 1084.78 | ATM CHECK DEPOSIT              ON              07/15 1505 W LAKE ST            Minneapolis   MN  0005549           ATM ID 6991J    CARD 7365 | bnk_84eda12f35102db75a5f0e04 → bnk_01d8d19ed6d703d5d99ef2e2
- 2021-12-16 | deposit 5203.21 | STRIPE           TRANSFER          ST-L1F4N2N4I3N3 THE WILDFLOWER FOUNDAT | bnk_c8eb72d0a70850948973d546 → bnk_39d907f60b5e7556dc6dffcb
- 2020-10-07 | deposit 5290.00 | ATM CHECK DEPOSIT              ON              10/07 1505 WEST LAKE ST         Minneapolis   MN  0009077           ATM ID 6991J    CARD 7365 | bnk_ca5b0ba9d33e2840537fbca6 → bnk_9f7d3cefe3fe9b798c2042d6
- 2022-01-05 | deposit 38000.00 | ATM CHECK DEPOSIT              ON              01/05 1505 W Lake St            Minneapolis   MN  0009988           ATM ID 6991K    CARD 7365 | bnk_7265e6812d5f90424fa08f7f → bnk_3bc02141708a474382b7aef2
- 2022-01-05 | deposit 38000.00 | ATM CHECK DEPOSIT              ON              01/05 1505 W Lake St            Minneapolis   MN  0009988           ATM ID 6991K    CARD 7365 | bnk_a6d642941444b439d07c6056 → bnk_3bc02141708a474382b7aef2
- 2018-05-30 | deposit 7120.20 | ATM CHECK DEPOSIT 05/30 1505 WEST LAKE ST MINNEAPOLIS MN 6991J 7365 | bnk_fa0f89d83609d9ccbef13e30 → bnk_a7a6de04b609da0b251a7123
- 2020-12-22 | deposit 44000.00 | ATM CHECK DEPOSIT              ON              12/22 7900 XERXES AVE S         BLOOMINGTON   MN  0003734           ATM ID 9961Z    CARD 7365 | bnk_7b6c4cdbbf81418fc20f42fc → bnk_d6538035383d7df725fa768e
- 2023-02-07 | deposit 34471.51 | ATM CHECK DEPOSIT              ON              02/07 4712 Chicago Ave          Minneapolis   MN  0005606           ATM ID 5819T    CARD 7365 | bnk_e2ded6fe7e004a0156646ab5 → bnk_280d81c846fd63db6d34dd8d
- 2021-02-25 | deposit 198114.04 | ATM CHECK DEPOSIT              ON              02/25 1505 WEST LAKE ST         Minneapolis   MN  0001211           ATM ID 6991J    CARD 7365 | bnk_6b1a650fe804e14cd2bac298 → bnk_84d369468200dd3eebffcebf
- 2024-08-12 | deposit 17534.21 | ATM CHECK DEPOSIT              ON              08/10 4712 Chicago Ave          Minneapolis   MN  0001575           ATM ID 5819T    CARD 0628 | bnk_e2e07b114ba3e01851eb421a → bnk_5135cfffcc5d048a22c87134
- 2018-08-01 | deposit 12300.00 | ATM CHECK DEPOSIT 08/01 4712 CHICAGO AVE S MINNEAPOLIS MN 5819T 7365 | bnk_eacc0f5f504e49f65af0691a → bnk_3f489b13110ad391462b177a
- 2021-06-21 | deposit 36361.56 | ATM CHECK DEPOSIT              ON              06/21 1505 W LAKE ST            Minneapolis   MN  0001572           ATM ID 6991J    CARD 7365 | bnk_dedf3854444cae626cb11a40 → bnk_9f1aa9def6ce5593a4c33285
- 2021-06-21 | deposit 36361.56 | ATM CHECK DEPOSIT              ON              06/21 1505 W LAKE ST            Minneapolis   MN  0001572           ATM ID 6991J    CARD 7365 | bnk_ee9f02c40987d8e13a4d6400 → bnk_9f1aa9def6ce5593a4c33285
- 2024-08-30 | deposit 5879.68 | ATM CHECK DEPOSIT              ON              08/30 7900 Xerxes Ave S Ste 201 Bloomington   MN  0001184           ATM ID 9961Z    CARD 0628 | bnk_7de576fbe97ba255be1ac3f0 → bnk_39e1870c99083e2d9ed879ca
- 2021-09-22 | deposit 21494.95 | ATM CHECK DEPOSIT              ON              09/22 1505 W LAKE ST            Minneapolis   MN  0000068           ATM ID 6993M    CARD 7365 | bnk_a0fe41399ea0a55d89dd1d82 → bnk_5def2b427be720fd43aa1792
- 2021-12-23 | deposit 200000.00 | ATM CHECK DEPOSIT              ON              12/23 1505 W Lake St            Minneapolis   MN  0001048           ATM ID 6991J    CARD 7365 | bnk_f984ed831232879621e13843 → bnk_0a6853fe6692c8a1f0626dc3
- 2019-04-29 | deposit 19814.92 | ATM CHECK DEPOSIT              ON              04/29 1505 WEST LAKE ST         MINNEAPOLIS   MN  0001907           ATM ID 6991J    CARD 7365 | bnk_f6757fb2e7282dc94f1baa38 → bnk_291996c6e15f4c5ed8953abb
- 2019-05-16 | deposit 36391.00 | ATM CHECK DEPOSIT              ON              05/16 3030 NICOLLET AVE         MINNEAPOLIS   MN  0007049           ATM ID 5813V    CARD 7365 | bnk_c041d7aa87fa50f3181dfa3e → bnk_7878e184f5c52656a5659af8
- 2024-10-03 | deposit 3945.85 | DC WILDFLOWER PU EFT PYMT   100224 Charter School  The Wildflower Foundat | bnk_d8106bdf6e13a2197512bc74 → bnk_d37079fe5d02a1c0044ebaca
- 2020-01-23 | deposit 26400.00 | ATM CHECK DEPOSIT              ON              01/23 1505 WEST LAKE ST         MINNEAPOLIS   MN  0007906           ATM ID 6991J    CARD 7365 | bnk_f3f3d7b9a649a7605c183c20 → bnk_0010009662ba00508350afc8
- 2019-10-08 | deposit 107553.13 | ATM CHECK DEPOSIT              ON              10/08 1505 WEST LAKE ST         MINNEAPOLIS   MN  0004918           ATM ID 6993M    CARD 7365 | bnk_c04618d5fba71261ec219907 → bnk_49e4b0ff14aadef303b8a5ce
- 2022-12-07 | deposit 5075.38 | STRIPE           TRANSFER          ST-Q1Y7G7H6E0F6 THE WILDFLOWER FOUNDAT | bnk_b7eed9b912c5df81ed020dfa → bnk_e9386079bfe9e5a954a59ff4
- 2024-02-02 | deposit 79993.65 | DEPOSIT | bnk_db21844793e07866c7b10ee6 → bnk_08b0af7bff92cc6ef6b200fe
- 2017-01-10 | deposit 6666.67 | ATM CHECK DEPOSIT 01/10 4712 CHICAGO AVE S MINNEAPOLIS MN 5819T 7365 | bnk_d7d92440aa4641ce8cbc6846 → bnk_097b58ec58073f697952bbb7
- 2019-02-26 | deposit 66032.90 | TRANSFER FROM BRK ****9888 REF# 265390478 | bnk_dd536d106813d97cdc9ce77d → bnk_c3e1649ebb6cc69648a08b18
- 2018-12-19 | deposit 11362.50 | ATM CHECK DEPOSIT              ON              12/19 1505 WEST LAKE ST         MINNEAPOLIS   MN  0007868           ATM ID 6991J    CARD 7365 201812193 | bnk_e866176027e84550b88b4cf7 → bnk_6106826bb46b9232dee0cb8c
- 2023-01-06 | deposit 160991.98 | ATM CHECK DEPOSIT              ON              01/06 4712 Chicago Ave          Minneapolis   MN  0009100           ATM ID 5819T    CARD 7365 | bnk_e32884769fc7b9770e2366c0 → bnk_e874121a49f57018a9f2d2c6
- 2018-07-09 | deposit 7357.40 | ATM CHECK DEPOSIT 07/09 4712 CHICAGO AVE S MINNEAPOLIS MN 5819T 7365 | bnk_fdbda2ac92d0960197094a9e → bnk_aaae8a7be959d877a5492b89
- 2019-11-04 | deposit 36219.00 | ATM CHECK DEPOSIT              ON              11/02 4712 CHICAGO AVE S        MINNEAPOLIS   MN  0001379           ATM ID 5819T    CARD 7365 | bnk_ef08089e38802f7842ff6816 → bnk_ed0acda686d08101839db986

## Composition sizing and legacy repairs

Machine components use each staged QBO line amount, never the whole bank deposit. The seven bdc_0172_* rows are excluded from the machine output; their replacement per-line rows are derived from QBO composing lines.
- bdc_0172_recnuRi71Ka63HceZ (bdep_0f2f008c03fed2cf015acab8): old 120000.00; machine line 80000.00 via bdc_rvGhMvR-GdgMw18HYQdcw.
- bdc_5L1YqDSwMIyqx1pnx_0Hl (bdep_0f2f008c03fed2cf015acab8): old 40000.00; machine line 40000.00 via bdc_5L1YqDSwMIyqx1pnx_0Hl.
- bdc_0172_recTUSUQJHoasnViD (bdep_4c12381756e99a952084ad71): old 250000.00; machine line not emitted.
- bdc_0172_recs30mG9xDAg81iz (bdep_52a7e23be4dd4387a2aff1ac): old 195000.00; machine line not emitted.
- bdc_0172_recjtiyQqiTD16KTv (bdep_69e6ba786a30ad402f0c8d9d): old 500000.00; machine line not emitted.
- bdc_0172_recPuB4akP0d4AZsN (bdep_80e541c591cbfe438a97fbf2): old 1500000.00; machine line 750000.00 via bdc_8r4tQubAh23RqksEG7OU-.
- bdc_fe20NzJrK3GYkpymmM9VD (bdep_80e541c591cbfe438a97fbf2): old 750000.00; machine line 750000.00 via bdc_fe20NzJrK3GYkpymmM9VD.
- bdc_0172_DWN2URcC3_p0WhfUItlxo (bdep_a858e4f94074dfd04a93ca05): old 1600000.00; machine line not emitted.
- bdc_0172_reckbnrhVwrpTUULL (bdep_b201d116ef46224cb6f36844): old 1000000.00; machine line not emitted.

### Known over-composed deposits
- Arthur Rock bdep_80e541c591cbfe438a97fbf2: production composition contains the 0172 $1,500,000 component plus a $750,000 second line against a $1,500,000 deposit. Machine composition emits the two QBO line amounts ($750,000 + $750,000).
- Howley bdep_0f2f008c03fed2cf015acab8: production composition contains the 0172 $120,000 component plus a $40,000 second line against a $120,000 deposit. Machine composition emits the two QBO line amounts ($80,000 + $40,000).

## Reconciliation checks

Every emitted component is checked against its machine deposit total.
No machine deposits are over-composed; all 175 component-bearing deposits have component totals ≤ deposit amounts.

## Deterministic versus dropped state

### Deterministic and included

- Canonical bank-native transaction rows and stable old→new ID remapping.
- Positive bank deposits projected from canonical bank rows.
- One payment unit per non-excluded Stripe charge, including deterministic lifecycle facts.
- Full step-4a QBO composition units across all CASE-derived kinds and per-line QBO composition, paired by exact QBO deposit total/date rank logic.
- Stripe payout ties using deterministic nearest eligible deposits within the recompute five-day forward window, including the ambiguity flag.
- QBO register evidence links using exact amount, a ±3-day window, and unique-only matching from both sides.

### Deliberately dropped

- bank_deposit_exclusions and all other human exclusion decisions.
- payment_applications and gifts_and_payments.
- The approximately 360 migration-0178 attribution-support kind=other units without qb_deposit_id; these are not machine money evidence and are deferred to human reapplication.
- Legacy bdc_0172_* hand-repair components.
- Existing production rows are not treated as machine authority; outputs are clean deterministic projections. The step-4a scope intentionally depends on charge_qb_tie/charge_fee_row source_links as an evidence-link dependency documented in the human registry.

## Output files

- bank_transactions_canonical.csv — canonical bank-native rows.
- id_remap.csv — every source bank transaction ID and deposit ID mapped to canonical IDs.
- bank_deposits.csv — positive canonical bank credits.
- payment_units.csv — Stripe and the full step-4a QBO composition-unit scope across all CASE-derived kinds.
- bank_deposit_components.csv — per-QBO-line direct composition with reconciliation flags.
- stripe_payout_ties.csv — deterministic payout-to-bank-deposit matches.
- qbo_register_links.csv — unique-only QBO register evidence links.
