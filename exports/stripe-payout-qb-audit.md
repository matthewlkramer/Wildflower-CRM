# Stripe payouts without a lump QB-deposit link — full audit (production, 2026-07-22)

Every Stripe payout that has no payout-level settlement link to a QuickBooks deposit, with every nearby QuickBooks record (±14 days, ANY amount).

## Bottom line

- 75 payouts have no lump deposit link.
- **59 of them are FULLY booked in QuickBooks** — per-donation, every charge confirmed-tied to its own QB row. These are settled; no action needed.
- The remaining 16 break down into: proposals awaiting confirmation, bookings in "odd shapes" the matcher can't recognize (combined rows, split rows, reversal-netted amounts, misspelled names), negative payouts (money OUT — no deposit expected), and two recent 2026 payouts likely awaiting bookkeeping.

## Section 1 — Fully booked per-donation (59 payouts, all charges confirmed)

| Arrival | Net | Charges (all tied to QB) |
|---|---|---|
| 2018-12-12 | $4.97 | 1/1 |
| 2022-06-09 | $4.49 | 1/1 |
| 2022-06-28 | $983.00 | 1/1 |
| 2022-06-28 | $39.71 | 1/1 |
| 2022-08-03 | $24.82 | 1/1 |
| 2022-08-21 | $4.96 | 1/1 |
| 2022-09-06 | $2.57 | 1/1 |
| 2022-09-21 | $49.64 | 1/1 |
| 2022-09-22 | $4.96 | 1/1 |
| 2022-09-29 | $378.32 | 2/2 |
| 2022-10-02 | $248.19 | 1/1 |
| 2022-10-03 | $99.27 | 1/1 |
| 2022-10-23 | $49.48 | 1/1 |
| 2022-11-30 | $8.94 | 2/2 |
| 2022-12-01 | $74.46 | 2/2 |
| 2022-12-05 | $500.00 | 1/1 |
| 2022-12-06 | $5075.38 | 3/3 |
| 2022-12-07 | $496.36 | 1/1 |
| 2022-12-13 | $198.55 | 1/1 |
| 2022-12-21 | $49.48 | 1/1 |
| 2022-12-28 | $238.70 | 1/1 |
| 2023-01-23 | $49.48 | 1/1 |
| 2023-02-22 | $49.48 | 1/1 |
| 2023-03-07 | $694.91 | 1/1 |
| 2023-03-19 | $4.96 | 1/1 |
| 2023-03-21 | $49.48 | 1/1 |
| 2023-05-21 | $5441.35 | 2/2 |
| 2023-05-31 | $248.18 | 1/1 |
| 2023-10-26 | $584.70 | 1/1 |
| 2024-01-03 | $238.07 | 1/1 |
| 2024-11-21 | $4767.20 | 1/1 |
| 2024-12-25 | $953.20 | 1/1 |
| 2025-02-09 | $714.83 | 1/1 |
| 2025-04-23 | $1901.70 | 1/1 |
| 2025-07-17 | $189.90 | 1/1 |
| 2025-12-03 | $593.23 | 2/2 |
| 2025-12-04 | $227.79 | 5/5 |
| 2025-12-07 | $146.55 | 1/1 |
| 2025-12-18 | $1447.06 | 2/2 |
| 2025-12-22 | $94.80 | 1/1 |
| 2025-12-23 | $1489.06 | 2/2 |
| 2025-12-30 | $94.80 | 1/1 |
| 2026-01-01 | $496.36 | 1/1 |
| 2026-01-05 | $99.27 | 1/1 |
| 2026-01-27 | $142.35 | 1/1 |
| 2026-01-29 | $248.17 | 1/1 |
| 2026-02-12 | $1922.64 | 8/8 |
| 2026-02-16 | $500.00 | 1/1 |
| 2026-02-16 | $5154.00 | 7/7 |
| 2026-02-17 | $950.70 | 1/1 |
| 2026-02-18 | $893.41 | 3/3 |
| 2026-02-24 | $47.25 | 1/1 |
| 2026-02-25 | $49.64 | 1/1 |
| 2026-03-01 | $47.25 | 1/1 |
| 2026-03-10 | $191.99 | 2/2 |
| 2026-03-24 | $47.25 | 1/1 |
| 2026-03-26 | $950.70 | 1/1 |
| 2026-04-09 | $142.35 | 1/1 |
| 2026-05-11 | $142.35 | 1/1 |

## Section 2 — The 16 payouts needing attention

Each payout below is shown with its Stripe charges (and tie state) followed by EVERY QuickBooks record within ±14 days regardless of amount. "FREE" = QB row not linked to anything yet; "tied"/"proposed"/"lump-linked" = already spoken for.


### Payout 2019-01-02 — net $5015.50 (1 charge, 0 confirmed, 0 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2018-12-31 | $5165.60 | $5015.50 | Timothy Welsh | - |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2018-12-19 | $1745.00 | payment | FREE | Loan - Wild Rose | Paid via QuickBooks Payments: Payme |  |
| 2018-12-19 | $362.50 | payment | FREE | Aster - Customer |  |  |
| 2018-12-19 | $10000.00 | payment | FREE | 4Point0 Schools |  |  |
| 2018-12-19 | $193.90 | deposit | FREE |  | STRIPE           TRANSFER           |  |
| 2018-12-19 | $205000.00 | deposit | FREE | New Schools Venture Fund | WT FED#03394 FIRST REPUBLIC BAN     |  |
| 2018-12-19 | $250.00 | payment | FREE | Loan - Capucine | Paid via QuickBooks Payments: Payme |  |
| 2018-12-19 | $75.00 | payment | FREE | Loan - Cosmos | Paid via QuickBooks Payments: Payme |  |
| 2018-12-19 | $1604.17 | payment | FREE | Loan - Wildflower | Paid via QuickBooks Payments: Payme |  |
| 2018-12-19 | $1000.00 | payment | FREE | Andrew B |  |  |
| 2018-12-20 | $53.10 | deposit | FREE |  | STRIPE           TRANSFER           |  |
| 2018-12-21 | $35000.00 | deposit | FREE | I.A. O'Shaughnessy Foundatio | ATM CHECK DEPOSIT              ON   |  |
| 2018-12-26 | $0.00 | deposit | FREE |  | Opening Balance from Bank |  |
| 2018-12-26 | $650000.00 | deposit | FREE | Silicon Valley Community Fou | WT SEQ142718 SILICON VALLEY COMMUNI |  |
| 2018-12-26 | $87582.28 | deposit | FREE |  | TRIPADVISOR INC |  |
| 2018-12-28 | $325.00 | payment | FREE | Wild Rose Montessori School  | Paid via QuickBooks Payments: Payme |  |
| 2018-12-28 | $87583.48 | deposit | FREE | Nancy Peretsman | TRANSFER FROM BRK ****9888 REF# 258 |  |
| 2018-12-28 | $15000.00 | deposit | FREE | Benjamin Statz | WT FED#07131 JPMORGAN CHASE BAN     |  |
| 2018-12-31 | $3.00 | deposit | FREE |  | STANDARD BANK DEPOSIT 123118 |  |
| 2018-12-31 | $237.50 | payment | FREE | Loan - Sweet Pea Montessori | Paid via QuickBooks Payments: Payme |  |
| 2018-12-31 | $87582.28 | deposit | FREE |  | STANDARD BANK DEPOSIT |  |
| 2019-01-02 | $2000.00 | payment | FREE | Loan - Snowdrop | Paid via QuickBooks Payments: Payme |  |
| 2019-01-03 | $1665.28 | payment | FREE | Loan - Dandelion | Paid via QuickBooks Payments: Payme |  |
| 2019-01-03 | $3000.00 | payment | FREE | Loan - Violeta | Paid via QuickBooks Payments: Payme |  |
| 2019-01-03 | $337.50 | payment | FREE | Dandelion Parent Education I | Paid via QuickBooks Payments: Payme |  |
| 2019-01-03 | $5300.00 | deposit | FREE | Tim Welsh | STRIPE           TRANSFER           |  |
| 2019-01-03 | $-284.50 | deposit | FREE | Tim Welsh | STRIPE           TRANSFER           |  |
| 2019-01-04 | $212.50 | payment | FREE | Loan - Tiger Lily | Paid via QuickBooks Payments: Payme |  |
| 2019-01-04 | $28.83 | deposit | FREE |  | STRIPE           TRANSFER           |  |
| 2019-01-08 | $1604.17 | payment | FREE | Loan - Wildflower | Paid via QuickBooks Payments: Payme |  |
| 2019-01-08 | $25000.00 | payment | FREE | Mandel/Fidelity |  |  |
| 2019-01-08 | $1794.00 | payment | FREE | Loan - Aster |  |  |
| 2019-01-08 | $25000.00 | payment | FREE | Frey Foundation |  |  |
| 2019-01-10 | $0.00 | payment | FREE | Loan - Capucine | Voided |  |
| 2019-01-10 | $250.00 | deposit | FREE | AMY HERTEL | Varde Management Wells Farg 190109  |  |
| 2019-01-11 | $48.98 | deposit | FREE |  | STRIPE           TRANSFER           |  |
| 2019-01-15 | $1604.17 | payment | FREE | Loan - Wildflower | Paid via QuickBooks Payments: Payme |  |
| 2019-01-15 | $1745.00 | payment | FREE | Loan - Wild Rose | Paid via QuickBooks Payments: Payme |  |
| 2019-01-16 | $485.20 | deposit | FREE |  | STRIPE           TRANSFER           |  |
| 2019-01-16 | $100.00 | deposit | FREE | Theodore Quinn_ | ATM CHECK DEPOSIT              ON   |  |

### Payout 2021-01-20 — net $-0.45 (1 charge, 0 confirmed, 0 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2021-01-16 | $5.00 | $4.49 | Allison Welch | - |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2021-01-06 | $0.00 | payment | FREE | Heartwood Montessori School | Voided |  |
| 2021-01-06 | $24.82 | deposit | lump-linked | Stripe | Donation DC Joel Steinberg |  |
| 2021-01-07 | $19.64 | deposit | FREE | Stripe |  |  |
| 2021-01-08 | $25000.00 | payment | FREE | New Schools Venture Fund |  |  |
| 2021-01-08 | $50000.00 | payment | FREE | The Douglass Brandenborg Fam |  |  |
| 2021-01-08 | $4000.00 | payment | FREE | Mastery |  |  |
| 2021-01-08 | $12000.00 | payment | FREE | Center for Popular Democracy |  |  |
| 2021-01-08 | $5000.00 | deposit | FREE | Saint Paul Foundation | Check: X210 $5,000.00 - STP, pass t |  |
| 2021-01-08 | $5000.00 | payment | FREE | Eagle Peak Montessori School |  |  |
| 2021-01-12 | $23.67 | deposit | lump-linked | Stripe | Donation Leah W |  |
| 2021-01-12 | $491.20 | deposit | FREE | Stripe | Donation- Teresa Smith |  |
| 2021-01-12 | $681.30 | deposit | FREE |  |  |  |
| 2021-01-13 | $7850.00 | payment | FREE | Centennial Montessori School | Paid via QuickBooks Payments: Payme |  |
| 2021-01-13 | $3396.40 | deposit | FREE | Stripe |  |  |
| 2021-01-13 | $842.05 | deposit | FREE | Stripe |  |  |
| 2021-01-14 | $2911.20 | deposit | FREE | Stripe | Charge - Delaney, Shah, Blake, Jone |  |
| 2021-01-15 | $970.40 | deposit | FREE | Stripe | Charge for Burgess and Mendez-Ortiz |  |
| 2021-01-20 | $485.20 | deposit | FREE | Stripe | Charge for Michelle Yang |  |
| 2021-01-21 | $416.67 | payment | FREE | Loan - Capucine | Paid via QuickBooks Payments: Payme |  |
| 2021-01-21 | $506.30 | deposit | FREE | Stripe |  |  |
| 2021-01-21 | $1164.00 | deposit | FREE | Stripe |  |  |
| 2021-01-21 | $4000.00 | payment | FREE | Think Small | Paid via QuickBooks Payments: Payme |  |
| 2021-01-25 | $368.21 | deposit | FREE | Commonwealth of Massachusett |  |  |
| 2021-01-25 | $120.42 | deposit | FREE | QuickBooks Payments |  |  |
| 2021-01-25 | $650.00 | deposit | FREE | Wells Fargo | Unidentified Deposit 01.25.2021 |  |
| 2021-01-25 | $7500.00 | deposit | FREE | Docebo NA Inc |  |  |
| 2021-01-26 | $300000.00 | payment | FREE | Stranahan Foundation |  |  |
| 2021-01-26 | $20000.00 | payment | FREE | Spring Point Partners |  |  |
| 2021-01-26 | $514.00 | deposit | FREE |  | •	$514 is the close out of petty ca |  |
| 2021-01-26 | $4000.00 | payment | FREE | Hilary Cuevas-Balanon |  |  |
| 2021-01-29 | $248.19 | deposit | FREE | Stripe |  |  |
| 2021-01-29 | $5000.00 | payment | FREE | Elm City Montessori |  |  |
| 2021-01-29 | $20000.00 | payment | FREE | Fidelity Charitable |  |  |
| 2021-01-29 | $6600.00 | payment | FREE | Ivy School |  |  |
| 2021-01-29 | $99392.20 | payment | FREE | Sep Kamvar |  |  |
| 2021-01-29 | $754880.00 | deposit | FREE |  |  |  |
| 2021-01-29 | $4000.00 | payment | FREE | Equitas Academy |  |  |
| 2021-01-29 | $2200.00 | payment | FREE | Heartwood Montessori School |  |  |
| 2021-01-29 | $25000.00 | payment | FREE | St Paul and Mpls Foundation |  |  |
| 2021-01-31 | $24.05 | deposit | FREE |  | Interest Earned |  |
| 2021-02-01 | $100000.00 | payment | FREE | Wend Ventures |  |  |
| 2021-02-01 | $650000.00 | payment | FREE | Wend Ventures |  |  |
| 2021-02-01 | $250000.00 | payment | FREE | Wend Ventures |  |  |
| 2021-02-02 | $474.68 | deposit | FREE | Gusto |  |  |
| 2021-02-03 | $74.00 | deposit | FREE | Gusto |  |  |

### Payout 2021-12-09 — net $5291.08 (2 charges, 0 confirmed, 2 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2021-12-08 | $5000.00 | $4794.70 | Shelly Fisher | proposed |
| 2021-12-08 | $517.91 | $496.38 | Dana Devon | proposed |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2021-11-26 | $250.00 | deposit | FREE |  |  |  |
| 2021-11-30 | $1.32 | deposit | FREE |  |  |  |
| 2021-11-30 | $7.39 | deposit | FREE |  | Interest Earned |  |
| 2021-12-01 | $250.00 | payment | FREE | Morgan Stanley |  |  |
| 2021-12-01 | $212.50 | payment | FREE | Morgan Stanley |  |  |
| 2021-12-01 | $25000.00 | payment | FREE | Temple Hoyne Buell Foundatio |  |  |
| 2021-12-02 | $247708.34 | deposit | FREE | US Department of Treasury | ERC Tax Refund. |  |
| 2021-12-02 | $500.00 | payment | FREE | Matt and Katie Kramer |  |  |
| 2021-12-02 | $943.07 | deposit | FREE | Loan - Tiger Lily |  |  |
| 2021-12-07 | $0.00 | payment | FREE | DC Wildflower Public Charter | Voided |  |
| 2021-12-07 | $51559.39 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-07 | $52166.80 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-10 | $0.00 | payment | FREE | DC Wildflower Public Charter | Voided |  |
| 2021-12-10 | $34341.60 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-10 | $93.10 | deposit | FREE |  | Give MN |  |
| 2021-12-10 | $4794.70 | deposit | proposed | Shelly Fisher | Wildflower Seed Fund: Elevating the | **amount matches a charge** |
| 2021-12-10 | $496.38 | deposit | proposed | Dana Devon | Wildflower Seed Fund: Elevating the | **amount matches a charge** |
| 2021-12-13 | $300000.00 | payment | FREE | Stranahan Foundation |  |  |
| 2021-12-13 | $5000.00 | payment | FREE | Saint Paul and Minnesota Fou |  | **amount matches a charge** |
| 2021-12-13 | $5000.00 | payment | FREE | Albright Foundation |  | **amount matches a charge** |
| 2021-12-13 | $194.87 | deposit | lump-linked | Suzanne Bakewell | Wildflower Seed Fund: Elevating the |  |
| 2021-12-13 | $2912.59 | deposit | FREE | State of Minnesota |  |  |
| 2021-12-13 | $709.30 | deposit | FREE | Commonwealth of Massachusett |  |  |
| 2021-12-13 | $150000.00 | deposit | FREE | WNYCS | WNYCS Loan Payment |  |
| 2021-12-16 | $103.83 | payment | FREE | Jill Blank |  |  |
| 2021-12-16 | $5099.38 | payment | FREE | Anne Essner |  |  |
| 2021-12-17 | $2500.00 | deposit | FREE | Incandescent | Gift from Incandescent to support t |  |
| 2021-12-17 | $239.45 | payment | proposed | Jan Levine |  |  |
| 2021-12-17 | $4627.34 | deposit | FREE | New Markets Support |  |  |
| 2021-12-20 | $47.65 | payment | proposed | Denise Bala |  |  |
| 2021-12-21 | $47.65 | payment | proposed | Josh Berberian |  |  |
| 2021-12-22 | $500000.00 | payment | FREE | Spring Point Partners |  |  |
| 2021-12-23 | $5000.00 | payment | FREE | Anonymous |  | **amount matches a charge** |
| 2021-12-23 | $45000.00 | payment | FREE | Latino Community Foundation  |  |  |
| 2021-12-23 | $50000.00 | payment | FREE | The Douglass Brandenborg Fam |  |  |
| 2021-12-23 | $100000.00 | payment | FREE | WEM Foundation |  |  |

### Payout 2021-12-15 — net $5203.21 (2 charges, 0 confirmed, 1 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2021-12-14 | $5176.29 | $4963.76 | Anne Essner | - |
| 2021-12-14 | $250.00 | $239.45 | Jan Levine | proposed |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2021-12-01 | $250.00 | payment | FREE | Morgan Stanley |  | **amount matches a charge** |
| 2021-12-01 | $212.50 | payment | FREE | Morgan Stanley |  |  |
| 2021-12-01 | $25000.00 | payment | FREE | Temple Hoyne Buell Foundatio |  |  |
| 2021-12-02 | $247708.34 | deposit | FREE | US Department of Treasury | ERC Tax Refund. |  |
| 2021-12-02 | $500.00 | payment | FREE | Matt and Katie Kramer |  |  |
| 2021-12-02 | $943.07 | deposit | FREE | Loan - Tiger Lily |  |  |
| 2021-12-07 | $0.00 | payment | FREE | DC Wildflower Public Charter | Voided |  |
| 2021-12-07 | $51559.39 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-07 | $52166.80 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-10 | $0.00 | payment | FREE | DC Wildflower Public Charter | Voided |  |
| 2021-12-10 | $34341.60 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-10 | $93.10 | deposit | FREE |  | Give MN |  |
| 2021-12-10 | $4794.70 | deposit | proposed | Shelly Fisher | Wildflower Seed Fund: Elevating the |  |
| 2021-12-10 | $496.38 | deposit | proposed | Dana Devon | Wildflower Seed Fund: Elevating the |  |
| 2021-12-13 | $300000.00 | payment | FREE | Stranahan Foundation |  |  |
| 2021-12-13 | $5000.00 | payment | FREE | Saint Paul and Minnesota Fou |  |  |
| 2021-12-13 | $5000.00 | payment | FREE | Albright Foundation |  |  |
| 2021-12-13 | $194.87 | deposit | lump-linked | Suzanne Bakewell | Wildflower Seed Fund: Elevating the |  |
| 2021-12-13 | $2912.59 | deposit | FREE | State of Minnesota |  |  |
| 2021-12-13 | $709.30 | deposit | FREE | Commonwealth of Massachusett |  |  |
| 2021-12-13 | $150000.00 | deposit | FREE | WNYCS | WNYCS Loan Payment |  |
| 2021-12-16 | $103.83 | payment | FREE | Jill Blank |  |  |
| 2021-12-16 | $5099.38 | payment | FREE | Anne Essner |  |  |
| 2021-12-17 | $2500.00 | deposit | FREE | Incandescent | Gift from Incandescent to support t |  |
| 2021-12-17 | $239.45 | payment | proposed | Jan Levine |  | **amount matches a charge** |
| 2021-12-17 | $4627.34 | deposit | FREE | New Markets Support |  |  |
| 2021-12-20 | $47.65 | payment | proposed | Denise Bala |  |  |
| 2021-12-21 | $47.65 | payment | proposed | Josh Berberian |  |  |
| 2021-12-22 | $500000.00 | payment | FREE | Spring Point Partners |  |  |
| 2021-12-23 | $5000.00 | payment | FREE | Anonymous |  |  |
| 2021-12-23 | $45000.00 | payment | FREE | Latino Community Foundation  |  |  |
| 2021-12-23 | $50000.00 | payment | FREE | The Douglass Brandenborg Fam |  |  |
| 2021-12-23 | $100000.00 | payment | FREE | WEM Foundation |  |  |

### Payout 2021-12-16 — net $239.45 (1 charge, 0 confirmed, 0 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2021-12-15 | $250.00 | $239.45 | Suzanne  Bakewell  | - |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2021-12-02 | $247708.34 | deposit | FREE | US Department of Treasury | ERC Tax Refund. |  |
| 2021-12-02 | $500.00 | payment | FREE | Matt and Katie Kramer |  |  |
| 2021-12-02 | $943.07 | deposit | FREE | Loan - Tiger Lily |  |  |
| 2021-12-07 | $0.00 | payment | FREE | DC Wildflower Public Charter | Voided |  |
| 2021-12-07 | $51559.39 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-07 | $52166.80 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-10 | $0.00 | payment | FREE | DC Wildflower Public Charter | Voided |  |
| 2021-12-10 | $34341.60 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-10 | $93.10 | deposit | FREE |  | Give MN |  |
| 2021-12-10 | $4794.70 | deposit | proposed | Shelly Fisher | Wildflower Seed Fund: Elevating the |  |
| 2021-12-10 | $496.38 | deposit | proposed | Dana Devon | Wildflower Seed Fund: Elevating the |  |
| 2021-12-13 | $300000.00 | payment | FREE | Stranahan Foundation |  |  |
| 2021-12-13 | $5000.00 | payment | FREE | Saint Paul and Minnesota Fou |  |  |
| 2021-12-13 | $5000.00 | payment | FREE | Albright Foundation |  |  |
| 2021-12-13 | $194.87 | deposit | lump-linked | Suzanne Bakewell | Wildflower Seed Fund: Elevating the |  |
| 2021-12-13 | $2912.59 | deposit | FREE | State of Minnesota |  |  |
| 2021-12-13 | $709.30 | deposit | FREE | Commonwealth of Massachusett |  |  |
| 2021-12-13 | $150000.00 | deposit | FREE | WNYCS | WNYCS Loan Payment |  |
| 2021-12-16 | $103.83 | payment | FREE | Jill Blank |  |  |
| 2021-12-16 | $5099.38 | payment | FREE | Anne Essner |  |  |
| 2021-12-17 | $2500.00 | deposit | FREE | Incandescent | Gift from Incandescent to support t |  |
| 2021-12-17 | $239.45 | payment | proposed | Jan Levine |  | **amount matches a charge** |
| 2021-12-17 | $4627.34 | deposit | FREE | New Markets Support |  |  |
| 2021-12-20 | $47.65 | payment | proposed | Denise Bala |  |  |
| 2021-12-21 | $47.65 | payment | proposed | Josh Berberian |  |  |
| 2021-12-22 | $500000.00 | payment | FREE | Spring Point Partners |  |  |
| 2021-12-23 | $5000.00 | payment | FREE | Anonymous |  |  |
| 2021-12-23 | $45000.00 | payment | FREE | Latino Community Foundation  |  |  |
| 2021-12-23 | $50000.00 | payment | FREE | The Douglass Brandenborg Fam |  |  |
| 2021-12-23 | $100000.00 | payment | FREE | WEM Foundation |  |  |

### Payout 2021-12-19 — net $47.65 (1 charge, 0 confirmed, 1 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2021-12-16 | $50.00 | $47.65 | Denise Bala | proposed |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2021-12-07 | $0.00 | payment | FREE | DC Wildflower Public Charter | Voided |  |
| 2021-12-07 | $51559.39 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-07 | $52166.80 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-10 | $0.00 | payment | FREE | DC Wildflower Public Charter | Voided |  |
| 2021-12-10 | $34341.60 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-10 | $93.10 | deposit | FREE |  | Give MN |  |
| 2021-12-10 | $4794.70 | deposit | proposed | Shelly Fisher | Wildflower Seed Fund: Elevating the |  |
| 2021-12-10 | $496.38 | deposit | proposed | Dana Devon | Wildflower Seed Fund: Elevating the |  |
| 2021-12-13 | $300000.00 | payment | FREE | Stranahan Foundation |  |  |
| 2021-12-13 | $5000.00 | payment | FREE | Saint Paul and Minnesota Fou |  |  |
| 2021-12-13 | $5000.00 | payment | FREE | Albright Foundation |  |  |
| 2021-12-13 | $194.87 | deposit | lump-linked | Suzanne Bakewell | Wildflower Seed Fund: Elevating the |  |
| 2021-12-13 | $2912.59 | deposit | FREE | State of Minnesota |  |  |
| 2021-12-13 | $709.30 | deposit | FREE | Commonwealth of Massachusett |  |  |
| 2021-12-13 | $150000.00 | deposit | FREE | WNYCS | WNYCS Loan Payment |  |
| 2021-12-16 | $103.83 | payment | FREE | Jill Blank |  |  |
| 2021-12-16 | $5099.38 | payment | FREE | Anne Essner |  |  |
| 2021-12-17 | $2500.00 | deposit | FREE | Incandescent | Gift from Incandescent to support t |  |
| 2021-12-17 | $239.45 | payment | proposed | Jan Levine |  |  |
| 2021-12-17 | $4627.34 | deposit | FREE | New Markets Support |  |  |
| 2021-12-20 | $47.65 | payment | proposed | Denise Bala |  | **amount matches a charge** |
| 2021-12-21 | $47.65 | payment | proposed | Josh Berberian |  | **amount matches a charge** |
| 2021-12-22 | $500000.00 | payment | FREE | Spring Point Partners |  |  |
| 2021-12-23 | $5000.00 | payment | FREE | Anonymous |  |  |
| 2021-12-23 | $45000.00 | payment | FREE | Latino Community Foundation  |  |  |
| 2021-12-23 | $50000.00 | payment | FREE | The Douglass Brandenborg Fam |  |  |
| 2021-12-23 | $100000.00 | payment | FREE | WEM Foundation |  |  |
| 2021-12-31 | $5.14 | deposit | FREE |  |  |  |
| 2021-12-31 | $212.50 | payment | FREE | Morgan Stanley |  |  |
| 2021-12-31 | $250.00 | payment | FREE | Morgan Stanley |  |  |

### Payout 2021-12-20 — net $47.65 (1 charge, 0 confirmed, 1 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2021-12-17 | $50.00 | $47.65 | Josh Berberian | proposed |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2021-12-07 | $0.00 | payment | FREE | DC Wildflower Public Charter | Voided |  |
| 2021-12-07 | $51559.39 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-07 | $52166.80 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-10 | $0.00 | payment | FREE | DC Wildflower Public Charter | Voided |  |
| 2021-12-10 | $34341.60 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2021-12-10 | $93.10 | deposit | FREE |  | Give MN |  |
| 2021-12-10 | $4794.70 | deposit | proposed | Shelly Fisher | Wildflower Seed Fund: Elevating the |  |
| 2021-12-10 | $496.38 | deposit | proposed | Dana Devon | Wildflower Seed Fund: Elevating the |  |
| 2021-12-13 | $300000.00 | payment | FREE | Stranahan Foundation |  |  |
| 2021-12-13 | $5000.00 | payment | FREE | Saint Paul and Minnesota Fou |  |  |
| 2021-12-13 | $5000.00 | payment | FREE | Albright Foundation |  |  |
| 2021-12-13 | $194.87 | deposit | lump-linked | Suzanne Bakewell | Wildflower Seed Fund: Elevating the |  |
| 2021-12-13 | $2912.59 | deposit | FREE | State of Minnesota |  |  |
| 2021-12-13 | $709.30 | deposit | FREE | Commonwealth of Massachusett |  |  |
| 2021-12-13 | $150000.00 | deposit | FREE | WNYCS | WNYCS Loan Payment |  |
| 2021-12-16 | $103.83 | payment | FREE | Jill Blank |  |  |
| 2021-12-16 | $5099.38 | payment | FREE | Anne Essner |  |  |
| 2021-12-17 | $2500.00 | deposit | FREE | Incandescent | Gift from Incandescent to support t |  |
| 2021-12-17 | $239.45 | payment | proposed | Jan Levine |  |  |
| 2021-12-17 | $4627.34 | deposit | FREE | New Markets Support |  |  |
| 2021-12-20 | $47.65 | payment | proposed | Denise Bala |  | **amount matches a charge** |
| 2021-12-21 | $47.65 | payment | proposed | Josh Berberian |  | **amount matches a charge** |
| 2021-12-22 | $500000.00 | payment | FREE | Spring Point Partners |  |  |
| 2021-12-23 | $5000.00 | payment | FREE | Anonymous |  |  |
| 2021-12-23 | $45000.00 | payment | FREE | Latino Community Foundation  |  |  |
| 2021-12-23 | $50000.00 | payment | FREE | The Douglass Brandenborg Fam |  |  |
| 2021-12-23 | $100000.00 | payment | FREE | WEM Foundation |  |  |
| 2021-12-31 | $5.14 | deposit | FREE |  |  |  |
| 2021-12-31 | $212.50 | payment | FREE | Morgan Stanley |  |  |
| 2021-12-31 | $250.00 | payment | FREE | Morgan Stanley |  |  |

### Payout 2022-01-03 — net $248.19 (1 charge, 0 confirmed, 1 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2021-12-31 | $259.11 | $248.19 | Erica Cantoni | proposed |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2021-12-20 | $47.65 | payment | proposed | Denise Bala |  |  |
| 2021-12-21 | $47.65 | payment | proposed | Josh Berberian |  |  |
| 2021-12-22 | $500000.00 | payment | FREE | Spring Point Partners |  |  |
| 2021-12-23 | $5000.00 | payment | FREE | Anonymous |  |  |
| 2021-12-23 | $45000.00 | payment | FREE | Latino Community Foundation  |  |  |
| 2021-12-23 | $50000.00 | payment | FREE | The Douglass Brandenborg Fam |  |  |
| 2021-12-23 | $100000.00 | payment | FREE | WEM Foundation |  |  |
| 2021-12-31 | $5.14 | deposit | FREE |  |  |  |
| 2021-12-31 | $212.50 | payment | FREE | Morgan Stanley |  |  |
| 2021-12-31 | $250.00 | payment | FREE | Morgan Stanley |  |  |
| 2022-01-04 | $248.19 | payment | proposed | Erica Cantoni (c) |  | **amount matches a charge** |
| 2022-01-05 | $500.00 | payment | FREE | Michael and Debbie Sorkin |  |  |
| 2022-01-05 | $30000.00 | deposit | FREE | Loan - Sweet Pea Montessori | Sweet Pea Loan Payment- GF Operatin |  |
| 2022-01-05 | $150.00 | deposit | FREE | Wells.CC |  |  |
| 2022-01-05 | $1000.00 | payment | FREE | Protouch Painting |  |  |
| 2022-01-05 | $1500.00 | payment | FREE | Protouch Painting |  |  |
| 2022-01-05 | $5000.00 | payment | FREE | Misc Customer |  |  |
| 2022-01-17 | $3223.34 | deposit | FREE |  |  |  |

### Payout 2022-02-01 — net $248.19 (1 charge, 0 confirmed, 0 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2022-01-31 | $259.11 | $248.19 | Erica Cantoni | - |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2022-01-18 | $1024.13 | deposit | FREE | Loan - Tiger Lily |  |  |
| 2022-01-24 | $1611.67 | deposit | FREE |  |  |  |
| 2022-01-26 | $1.33 | deposit | FREE | Gusto |  |  |
| 2022-01-27 | $25000.00 | payment | FREE | Liz Walker |  |  |
| 2022-01-28 | $80000.00 | payment | FREE | WNYCS |  |  |
| 2022-01-31 | $75000.00 | payment | FREE | Wend Ventures |  |  |
| 2022-01-31 | $250.00 | deposit | FREE | Morgan Stanley | Dahlia Montessori Repayment |  |
| 2022-01-31 | $212.50 | deposit | FREE | Morgan Stanley | Dahlia Montessori Repayment |  |
| 2022-01-31 | $475000.00 | payment | FREE | Wend Ventures |  |  |
| 2022-01-31 | $5.13 | deposit | FREE |  |  |  |
| 2022-01-31 | $200000.00 | payment | FREE | Wend Ventures |  |  |
| 2022-02-02 | $248.19 | payment | FREE | Erica Cantoni (c) |  | **amount matches a charge** |
| 2022-02-11 | $625.00 | payment | FREE | Loan - Cosmos |  |  |
| 2022-02-11 | $350.00 | deposit | FREE | Wells.CC | Wells Fargo Credit Card rewards |  |

### Payout 2022-05-30 — net $2076.66 (8 charges, 7 confirmed, 0 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2022-03-05 | $2000.00 | $1917.70 | Scott Greenfield | - |
| 2022-03-10 | $103.83 | $99.27 | TC & Joe Scornavacchi | confirmed |
| 2022-03-07 | $103.83 | $99.27 | John Campbell | confirmed |
| 2022-04-21 | $52.07 | $49.64 | Dane Cooper | confirmed |
| 2022-03-03 | $52.07 | $49.64 | Seth Cohn | confirmed |
| 2022-03-03 | $52.07 | $49.64 | Timothy Bonner | confirmed |
| 2022-03-03 | $50.00 | $47.65 | Scott Woodward | confirmed |
| 2022-03-02 | $21.01 | $19.85 | Andrew  White | confirmed |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2022-05-18 | $2997.09 | deposit | FREE | US Department of Treasury |  |  |
| 2022-05-20 | $500000.00 | payment | FREE | OMIDYAR NETWORK FUND INC |  |  |
| 2022-05-26 | $30000.00 | deposit | FREE | LOAN FUND 1 |  |  |
| 2022-05-31 | $49.64 | payment | tied | Timothy Bonner |  | **amount matches a charge** |
| 2022-05-31 | $5.13 | deposit | FREE |  |  |  |
| 2022-05-31 | $99.27 | payment | tied | TC & Joe Scornavacchi |  | **amount matches a charge** |
| 2022-05-31 | $47.65 | payment | tied | Scott Woodward |  | **amount matches a charge** |
| 2022-05-31 | $49.64 | payment | tied | Seth Cohn |  | **amount matches a charge** |
| 2022-05-31 | $1661.70 | payment | FREE | Scott Greenfield |  |  |
| 2022-05-31 | $99.27 | payment | tied | John Campbell |  | **amount matches a charge** |
| 2022-05-31 | $19.85 | payment | tied | Andrew White |  | **amount matches a charge** |
| 2022-05-31 | $117.35 | deposit | FREE |  | Interest Earned |  |
| 2022-05-31 | $49.64 | payment | tied | Dane Cooper |  | **amount matches a charge** |
| 2022-05-31 | $8.75 | deposit | FREE | Amazon Smile |  |  |
| 2022-06-03 | $25000.00 | payment | FREE | Citybridge Foundation |  |  |
| 2022-06-03 | $250000.00 | payment | FREE | Arthur Rock Foundation |  |  |
| 2022-06-03 | $750000.00 | payment | FREE | Arthur Rock Foundation |  |  |
| 2022-06-03 | $50000.00 | payment | FREE | Citybridge Foundation |  |  |
| 2022-06-10 | $4.49 | payment | tied | Erica Cantoni (c) |  |  |
| 2022-06-13 | $1611.67 | deposit | FREE |  |  |  |

### Payout 2022-07-21 — net $49.64 (1 charge, 0 confirmed, 0 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2022-07-20 | $52.07 | $49.64 | Annie Kuthart | - |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2022-07-13 | $30000.00 | deposit | FREE | The Sauer Family Foundation |  |  |
| 2022-07-19 | $1611.67 | deposit | FREE |  |  |  |
| 2022-07-22 | $49.64 | deposit | lump-linked | Stripe |  | **amount matches a charge** |
| 2022-07-25 | $113.44 | deposit | FREE | Houghton, Jennie |  |  |
| 2022-07-27 | $694.93 | deposit | lump-linked | Stripe |  |  |
| 2022-07-28 | $580000.00 | deposit | FREE | Anonymous |  |  |
| 2022-07-31 | $5.13 | deposit | FREE |  |  |  |
| 2022-07-31 | $627.76 | deposit | FREE |  | Interest Earned |  |
| 2022-08-04 | $24.82 | payment | tied | Alex Hanna |  |  |

### Payout 2022-09-27 — net $1422.52 (7 charges, 0 confirmed, 0 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2022-09-26 | $1035.51 | $992.75 | Mark Ethier | - |
| 2022-09-25 | $103.83 | $99.27 | Brinda Sen | - |
| 2022-09-26 | $100.00 | $95.60 | Kirsti Forrest | - |
| 2022-09-26 | $100.00 | $95.60 | Stephanie  Branca  | - |
| 2022-09-25 | $100.00 | $95.60 | Lindsey sudbury | - |
| 2022-09-24 | $26.19 | $24.82 | Jade Rivera | - |
| 2022-09-26 | $20.00 | $18.88 | Yvonne Baicich | - |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2022-09-14 | $937.66 | deposit | FREE |  |  |  |
| 2022-09-15 | $400000.00 | payment | FREE | Walton Family Foundation |  |  |
| 2022-09-15 | $3223.34 | deposit | FREE |  |  |  |
| 2022-09-20 | $10400.50 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2022-09-20 | $9950.50 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2022-09-22 | $49.64 | payment | tied | Annie Kuthart |  |  |
| 2022-09-22 | $0.05 | deposit | FREE |  |  |  |
| 2022-09-22 | $0.46 | deposit | FREE |  |  |  |
| 2022-09-23 | $4.96 | payment | tied | Erica Cantoni (c) |  |  |
| 2022-09-26 | $1449.22 | payment | lump-linked | Misc Customer |  |  |
| 2022-09-27 | $0.00 | payment | FREE | Misc Customer | Voided |  |
| 2022-09-27 | $85000.00 | deposit | FREE | Morgan Stanley |  |  |
| 2022-09-27 | $219.69 | payment | lump-linked | Misc Customer |  |  |
| 2022-09-28 | $1378.82 | payment | FREE | Misc Customer |  |  |
| 2022-09-28 | $0.00 | payment | FREE | Jaders F | Voided |  |
| 2022-09-28 | $0.00 | payment | FREE | Misc Customer | Voided |  |
| 2022-09-28 | $24.82 | payment | FREE | Jaders F |  | **amount matches a charge** |
| 2022-09-28 | $18.88 | payment | FREE | Misc Customer |  | **amount matches a charge** |
| 2022-09-30 | $248.19 | payment | tied | Sunny Greenberg (c) |  |  |
| 2022-09-30 | $1348.29 | deposit | FREE |  | Interest Earned |  |
| 2022-09-30 | $62.83 | deposit | FREE |  | Interest Earned |  |
| 2022-09-30 | $130.13 | payment | tied | Susie Wise |  |  |
| 2022-10-03 | $248.19 | payment | tied | Brenda Andrewson |  |  |
| 2022-10-04 | $99.27 | payment | tied | Alia Peera (c) |  | **amount matches a charge** |
| 2022-10-05 | $99.27 | payment | tied | Alison Macdonald |  | **amount matches a charge** |
| 2022-10-05 | $99.27 | payment | FREE | Raphael Gang (c) |  | **amount matches a charge** |
| 2022-10-06 | $220.00 | payment | FREE | Network For Good |  |  |
| 2022-10-06 | $20000.00 | payment | FREE | Mortenson Family Foundation |  |  |
| 2022-10-06 | $150.00 | payment | FREE | Schwab Charitable |  |  |
| 2022-10-06 | $1663.61 | payment | FREE | Guardian Life Insurance |  |  |

### Payout 2022-10-04 — net $198.54 (2 charges, 1 confirmed, 0 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2022-10-03 | $103.83 | $99.27 | Raphael Gang | confirmed |
| 2022-10-01 | $103.83 | $99.27 | Ali Scholes | - |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2022-09-20 | $10400.50 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2022-09-20 | $9950.50 | payment | FREE | DC Wildflower Public Charter |  |  |
| 2022-09-22 | $49.64 | payment | tied | Annie Kuthart |  |  |
| 2022-09-22 | $0.05 | deposit | FREE |  |  |  |
| 2022-09-22 | $0.46 | deposit | FREE |  |  |  |
| 2022-09-23 | $4.96 | payment | tied | Erica Cantoni (c) |  |  |
| 2022-09-26 | $1449.22 | payment | lump-linked | Misc Customer |  |  |
| 2022-09-27 | $0.00 | payment | FREE | Misc Customer | Voided |  |
| 2022-09-27 | $85000.00 | deposit | FREE | Morgan Stanley |  |  |
| 2022-09-27 | $219.69 | payment | lump-linked | Misc Customer |  |  |
| 2022-09-28 | $1378.82 | payment | FREE | Misc Customer |  |  |
| 2022-09-28 | $0.00 | payment | FREE | Jaders F | Voided |  |
| 2022-09-28 | $0.00 | payment | FREE | Misc Customer | Voided |  |
| 2022-09-28 | $24.82 | payment | FREE | Jaders F |  |  |
| 2022-09-28 | $18.88 | payment | FREE | Misc Customer |  |  |
| 2022-09-30 | $248.19 | payment | tied | Sunny Greenberg (c) |  |  |
| 2022-09-30 | $1348.29 | deposit | FREE |  | Interest Earned |  |
| 2022-09-30 | $62.83 | deposit | FREE |  | Interest Earned |  |
| 2022-09-30 | $130.13 | payment | tied | Susie Wise |  |  |
| 2022-10-03 | $248.19 | payment | tied | Brenda Andrewson |  |  |
| 2022-10-04 | $99.27 | payment | tied | Alia Peera (c) |  | **amount matches a charge** |
| 2022-10-05 | $99.27 | payment | tied | Alison Macdonald |  | **amount matches a charge** |
| 2022-10-05 | $99.27 | payment | FREE | Raphael Gang (c) |  | **amount matches a charge** |
| 2022-10-06 | $220.00 | payment | FREE | Network For Good |  |  |
| 2022-10-06 | $20000.00 | payment | FREE | Mortenson Family Foundation |  |  |
| 2022-10-06 | $150.00 | payment | FREE | Schwab Charitable |  |  |
| 2022-10-06 | $1663.61 | payment | FREE | Guardian Life Insurance |  |  |
| 2022-10-12 | $514.17 | deposit | FREE |  |  |  |

### Payout 2024-09-29 — net $-1023.21 (0 charges, 0 confirmed, 0 proposed)

_No charges (negative/adjustment payout — money moved OUT of the bank; no QB deposit is expected)._

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2024-09-16 | $653.68 | payment | FREE | Sundrops Montessori School | Inv 79252461-138 |  |
| 2024-09-18 | $811.08 | payment | FREE | Snowdrop Montessori School I | Inv 79252461-144 |  |
| 2024-09-18 | $992.71 | deposit | lump-linked | Stripe |  |  |
| 2024-09-20 | $1046.72 | payment | FREE | Clover Montessori School |  |  |
| 2024-09-23 | $4523.02 | payment | FREE | Wildflower New York Charter  | Inv 79252461-193 |  |
| 2024-09-24 | $545.45 | payment | FREE | Pinyon Montessori |  |  |
| 2024-09-24 | $545.45 | payment | FREE | Blazing Stars Montessori Sch |  |  |
| 2024-09-24 | $454.55 | payment | FREE | Meadow Rue (C) | Membership fee Oct payment - came i |  |
| 2024-09-24 | $545.45 | payment | FREE | Mountain Juniper | Membership fee Oct payment - came i |  |
| 2024-09-24 | $2522.44 | payment | FREE | Wild Rose Montessori School  | Inv # 79252461-205 |  |
| 2024-09-25 | $545.45 | payment | FREE | Rain Lily Montessori School, | Inv 79252461-203 |  |
| 2024-09-25 | $1282.33 | payment | FREE | Urban Village Montessori | Inv 79252461-214 |  |
| 2024-09-27 | $545.45 | payment | FREE | Desert Peach Montessori | Inv 79252461-228 |  |
| 2024-09-27 | $811.08 | payment | FREE | Snowdrop Montessori School I | Inv 79252461-200 |  |
| 2024-09-30 | $6.27 | deposit | FREE | Bremer Bank |  |  |
| 2024-09-30 | $28009.66 | deposit | FREE |  | Interest Earned |  |
| 2024-09-30 | $10000.00 | deposit | FREE | Hanhwa Kao | Start-up funding for The Girasol Sc |  |
| 2024-10-01 | $1500.02 | payment | FREE | Capucine Montessori, Inc. |  |  |
| 2024-10-01 | $861.47 | payment | FREE | Allium Montessori School, In |  |  |
| 2024-10-01 | $981.82 | payment | FREE | Azalea Primary (C) |  |  |
| 2024-10-01 | $500000.00 | deposit | FREE |  |  |  |
| 2024-10-01 | $612.56 | payment | FREE | Montessori Field School |  |  |
| 2024-10-02 | $545.45 | payment | FREE | Ixora Montessori, Inc. |  |  |
| 2024-10-02 | $653.68 | payment | FREE | Sundrops Montessori School |  |  |
| 2024-10-02 | $545.45 | payment | FREE | Sage Montessori, Inc. | Inv 79252461-224 |  |
| 2024-10-02 | $1004.74 | payment | FREE | Echinacea Montessori School |  |  |
| 2024-10-02 | $545.45 | payment | FREE | Flame Lily Montessori |  |  |
| 2024-10-03 | $0.00 | payment | FREE | Dandelion Parent Education I | Voided |  |
| 2024-10-03 | $945.94 | payment | FREE | Wisteria Montessori, Inc |  |  |
| 2024-10-03 | $454.55 | payment | FREE | Blue Montessori (C) |  |  |
| 2024-10-03 | $3491.30 | payment | FREE | Riverseed (C) |  |  |
| 2024-10-03 | $0.00 | payment | FREE | Minnesota Wildflower Montess | Voided - Multiple invoices |  |
| 2024-10-04 | $0.00 | payment | FREE | Lirio (C) | Voided - Came via MWMS Bill |  |
| 2024-10-04 | $1305.91 | payment | FREE | Lirio (C) |  |  |
| 2024-10-08 | $1514.54 | payment | FREE | Dandelion Parent Education I |  |  |
| 2024-10-08 | $15.59 | deposit | FREE | Gusto |  |  |

### Payout 2026-06-23 — net $99.27 (1 charge, 0 confirmed, 0 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2026-06-18 | $104.70 | $99.27 | Erica Cantoni | - |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2026-06-10 | $150.00 | deposit | lump-linked | Alexander Brown | Alexander Brown donation to BWF via |  |
| 2026-06-10 | $-7.65 | deposit | FREE | Stripe | Alexander Brown donation to BWF via |  |
| 2026-06-11 | $4990.56 | payment | FREE | Wildflower New York Charter  | Inv TWF - May Invoice037 |  |
| 2026-06-12 | $104.70 | deposit | FREE | Jacqui Miller | Donation to BWF from Erica Cantoni  | **amount matches a charge** |
| 2026-06-12 | $-5.43 | deposit | FREE | Stripe | Donation to BWF from Erica Cantoni  |  |
| 2026-06-12 | $189876.47 | deposit | FREE | Sunbeam | To record Dahlia Elem School loan & |  |
| 2026-06-15 | $666.67 | payment | FREE | Orchid Montessori School | Inv TWF - DecInv123 |  |
| 2026-06-22 | $3861.00 | payment | FREE | Snapdragon Montessori School |  |  |
| 2026-06-22 | $666.67 | payment | FREE | Acacia Montessori |  |  |
| 2026-06-23 | $45235.11 | payment | FREE | CSP | To record CSP reimbursement |  |
| 2026-06-24 | $2675.89 | payment | FREE | Jun Zi Lan Montessori School |  |  |

### Payout 2026-07-09 — net $142.35 (1 charge, 0 confirmed, 0 proposed)

**Stripe charges:**

| Date | Gross | Net | Donor | QB tie |
|---|---|---|---|---|
| 2026-07-08 | $150.00 | $142.35 | Alexander Brown | - |

**Every QB record within ±14 days:**

| Date | Amount | Type | Status | Payer | Memo | |
|---|---|---|---|---|---|---|
| 2026-07-10 | $3750.00 | payment | FREE | The Sunlight Loan Fund, LLC | Inv TWF-SL InvQ4-26 |  |
| 2026-07-22 | $0.00 | payment | FREE | Goldenrod Montessori School |  |  |

## Section 3 — Decoded "odd shapes" (why the matcher missed them)

1. **2022-09-27 ($1,422.52)** — fully booked as THREE QB rows on 9/28: $1,378.82 "Misc Customer" (= the 5 larger donations combined: 992.75+99.27+95.60+95.60+95.60), $24.82 "Jaders F" (= Jade Rivera), $18.88 "Misc Customer" (= Yvonne Baicich). Sum is exactly the payout net.
2. **2019-01-02 ($5,015.50)** — booked as TWO rows on 1/3/2019: $5,300.00 and −$284.50, both "Tim Welsh / STRIPE TRANSFER". 5300.00 − 284.50 = 5015.50 exactly.
3. **2022-05-30 ($2,076.66)** — 7 of 8 charges confirmed. The 8th (Scott Greenfield, net $1,917.70) is booked as $1,661.70 = 1917.70 − 256.00: the bookkeeper netted the −$256.00 failed-payout reversal (the 2022-02-02 failed payout) into this booking. QB ties to the bank; the matcher can't see it because the amount differs.
4. **2021-12-09 / 2021-12-15 / 2021-12-19 / 2021-12-20 / 2022-01-03** — exact QB matches already found by the system, sitting as unconfirmed proposals in the workbench (Shelly Fisher $4,794.70, Dana Devon $496.38, Jan Levine $239.45, Denise Bala $47.65, Josh Berberian $47.65, Erica Cantoni $248.19). Anne Essner (net $4,963.76) appears booked as $5,099.38 on 12/16 — a different amount, so no proposal.
5. **2022-10-04 ($198.54)** — Raphael Gang's charge is tied; Ali Scholes ($99.27) is not, but a FREE $99.27 QB row labeled "Raphael Gang (c)" on 10/5 is almost certainly Ali's donation booked under the wrong name.
6. **2022-02-01 ($248.19)** — exact FREE QB match exists: $248.19 "Erica Cantoni (c)" on 2/2. **2021-12-16** (Suzanne Bakewell $239.45) — nearest same-amount row is the $239.45 "Jan Levine" payment already proposed to Jan's own charge; Suzanne's booking may be under another name/amount.
7. **2022-07-21 ($49.64)** — an exact $49.64 "Stripe" deposit on 7/22 exists but is already lump-linked to a different payout; worth double-checking that link.
8. **2021-01-20 (−$0.45) and 2024-09-29 (−$1,023.21)** — negative payouts: Stripe debited the bank. No QB deposit will ever exist; these should be resolved as withdrawals.
9. **2026-06-23 ($99.27) and 2026-07-09 ($142.35)** — recent; likely genuinely not booked yet.