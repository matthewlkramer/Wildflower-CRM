# Human decisions registry

This registry is a read-only production snapshot for rebuilding the bank-spine money model. It records persisted human decisions, rule-derived classifications, evidence links, and legacy repair rows without writing to production. The CSVs are intentionally evidence-heavy and properly quoted.

Generated from PROD_DATABASE_URL_READONLY on 2026-07-26. The source branch contains no production-data mutation.

## Registry counts

| Category | Rows |
|---|---:|
| Deposit exclusions | 668 |
| Human-created exclusions | 16 |
| Rule-derived exclusions | 652 |
| Gift attribution applications | 949 |
| Counted applications | 777 |
| Applications that created gifts | 112 |
| Source links | 160 |
| Legacy 0172 components | 7 |
| Coding-form gift mappings | 232 |
| Coding-form mappings explicitly confirmed by a user | 222 |

### Exclusion counts by source

Human exclusions:
- tax_refund: 1
- earned_income: 4
- intercompany_transfer: 6
- other: 2
- expense_refund: 3

Rule-derived exclusions:
- loan: 56
- membership: 172
- interest: 6
- earned_income: 208
- intercompany_transfer: 20
- expense_refund: 180
- loan_repayment: 10

### Source-link counts

- charge_qb_tie / system / proposed: 3
- charge_qb_tie / human / confirmed: 115
- charge_fee_row / system_confirmed / confirmed: 42

## 0185 exclusion classification rule

Migration 0185 is a one-time, conservative, rule-derived classification. It considers componentless, still-open bank deposits whose QBO evidence comes from deposit_qbo_components → staged_payments. A deposit qualifies only when every QBO account line is a clear non-donation line, there is at least one non-donation line, there are zero donation lines, and there are zero ambiguous lines. Donation is any account containing “donation” (case-insensitive).

The account-line CASE classification is: an account containing “donation” is donation; an exact match for 4030 Other Revenue, 4099 Uncategorized Revenue, or 4102 Guaranty Revenue, the value “(none)”, or any account containing “uncategorized revenue” is ambiguous; everything else is initially nondonation. The exclusion is written only when all lines are nondonation, with zero donation and zero ambiguous lines.

Ambiguous accounts that prevent exclusion: 4030 Other Revenue, 4099 Uncategorized Revenue, 4102 Guaranty Revenue, any account containing “uncategorized revenue”, and missing account (“(none)”). A real 4000*/4100* donation line leaves the deposit in the fundraising queue.

Priority mapping:

| Priority | Account/name rule | Reason |
|---:|---|---|
| 1 | contains loan, line of credit, note payable, or ppp | loan |
| 2 | contains membership | membership |
| 3 | contains earned income or services - | earned_income |
| 4 | contains interest | interest |
| 5 | begins with 100 or 150, or contains brokerage, checking, receivable, clearing, uncategorized asset, or bill.com | intercompany_transfer |
| 6 | contains payroll, benefit, all other expenditures, grants to schools, research partnership, or taxes | expense_refund |
| 9 | any other non-donation account | other |

This is reproducible machine classification, not an individual deposit-by-deposit judgment. The human override surface is the 16 exclusions whose created_by_user_id is set.

## Explicit policies and reversals

### Migration 0186 — CSP/CSGF reversal

The owner explicitly reversed 32 erroneous deposit-level exclusions: 31 CSP→Operating receipts and one $150,000 “Loan from CSGF”. CSP pledge originals land in a separate Bremer account not present in the Wells Fargo feed, so the CSP→Operating inflow is the real receipt rather than a double-count. The separate $20 Gusto payroll refund containing “csp” was deliberately not reversed. Those rows are absent from the current exclusion table and are preserved here as policy context rather than active exclusions.

### Future attribution policy — Wildflower schools

Any payment from a Wildflower school is earned income or a loan payment, never a donation. This is a policy for future attribution/review, not a new classification applied by this registry.

## Human hand-call exclusions

There are 16 active exclusions with a non-null created_by_user_id. These are the explicit human hand-calls and are listed in full below. Their QBO evidence is also retained in exclusions.csv.

### bdep_19ce3d08896e9add231a4392 — 118363.19 on "2026-07-09T00:00:00.000Z"
- Deposit memo: ONLINE TRANSFER JUNE 26 OPEX DRAW 1 REF #BB0YVGT8FZ
- Reason: other
- Created by: usr_matthew_kramer at "2026-07-25T16:01:42.223Z"
- Note: (none)
- QBO accounts/categories: (none found)
- QBO payer(s): (none found)
- QBO evidence: []

### bdep_3801be9e4b9c7a3fae043acb — 65.62 on "2026-07-07T00:00:00.000Z"
- Deposit memo: GUSTO PAYROLL    TAX 832906 260707 6seml615btc     The Wildflower Foundat
- Reason: tax_refund
- Created by: usr_matthew_kramer at "2026-07-25T16:02:51.896Z"
- Note: (none)
- QBO accounts/categories: (none found)
- QBO payer(s): (none found)
- QBO evidence: []

### bdep_407a639e58ae91874f7010da — 3945.85 on "2025-08-04T00:00:00.000Z"
- Deposit memo: DC WILDFLOWER PU EFT PYMT   080125 Charter School  The Wildflower Foundat
- Reason: earned_income
- Created by: usr_matthew_kramer at "2026-07-25T16:05:50.813Z"
- Note: (none)
- QBO accounts/categories: (none found)
- QBO payer(s): (none found)
- QBO evidence: []

### bdep_4ac3e77cdc2af573c31b7933 — 300000.00 on "2026-07-14T00:00:00.000Z"
- Deposit memo: TRANSFER FROM BRK ****9888 REF# 632826369
- Reason: intercompany_transfer
- Created by: usr_matthew_kramer at "2026-07-25T16:01:19.417Z"
- Note: (none)
- QBO accounts/categories: (none found)
- QBO payer(s): (none found)
- QBO evidence: []

### bdep_5d9bb719bbab1b2288d234d0 — 200000.00 on "2026-02-27T00:00:00.000Z"
- Deposit memo: TRANSFER FROM BRK ****9888 REF# 615328531
- Reason: intercompany_transfer
- Created by: usr_matthew_kramer at "2026-07-25T20:48:22.746Z"
- Note: (none)
- QBO accounts/categories: 1004 BROKERAGE
- QBO payer(s): (none found)
- QBO evidence: [{"source":"bank_deposit_qbo_register","id":"bdqr_bdep_5d9bb719bbab1b2288d234d0","bank_transaction_id":"bnk_28c7af574403110730e32cd7","amount":"200000.00","txn_date":"2026-02-27T00:00:00.000Z","txn_type":"Transfer","accounts":["1004 BROKERAGE"],"memo":"Transfer to operations account","reconciliation_status":"Reconciled"}]

### bdep_6a7405fd4827423d2b08bfae — 300000.00 on "2026-07-01T00:00:00.000Z"
- Deposit memo: TRANSFER FROM BRK ****9888 REF# 631507914
- Reason: intercompany_transfer
- Created by: usr_matthew_kramer at "2026-07-25T16:03:11.315Z"
- Note: (none)
- QBO accounts/categories: (none found)
- QBO payer(s): (none found)
- QBO evidence: []

### bdep_74316e836ba3ba6ec162dc7a — 400000.00 on "2026-02-04T00:00:00.000Z"
- Deposit memo: TRANSFER FROM BRK ****9888 REF# 612560826
- Reason: intercompany_transfer
- Created by: usr_matthew_kramer at "2026-07-25T20:48:51.219Z"
- Note: (none)
- QBO accounts/categories: 1004 BROKERAGE
- QBO payer(s): (none found)
- QBO evidence: [{"source":"bank_deposit_qbo_register","id":"bdqr_bdep_74316e836ba3ba6ec162dc7a","bank_transaction_id":"bnk_bc38330cb8850f20bc75cf77","amount":"400000.00","txn_date":"2026-02-04T00:00:00.000Z","txn_type":"Transfer","accounts":["1004 BROKERAGE"],"memo":"Transfer to monthly operations","reconciliation_status":"Reconciled"}]

### bdep_83a68fcfd4b16e1c422a3c1f — 3945.85 on "2025-08-11T00:00:00.000Z"
- Deposit memo: DC WILDFLOWER PU EFT PYMT   080825 Charter School  The Wildflower Foundat
- Reason: earned_income
- Created by: usr_matthew_kramer at "2026-07-25T16:05:35.098Z"
- Note: (none)
- QBO accounts/categories: (none found)
- QBO payer(s): (none found)
- QBO evidence: []

### bdep_846fac1e59f2d2c4b12f5e07 — 122687.35 on "2026-07-15T00:00:00.000Z"
- Deposit memo: ONLINE TRANSFER JUNE OPEX 2 BUT DRAW WAS FOR 126K  REF #BB0YXLPK8T
- Reason: other
- Created by: usr_matthew_kramer at "2026-07-25T16:02:18.731Z"
- Note: (none)
- QBO accounts/categories: (none found)
- QBO payer(s): (none found)
- QBO evidence: []

### bdep_9758432a6823e4d50e53ceeb — 6000.00 on "2025-08-12T00:00:00.000Z"
- Deposit memo: Bill.com         VoidPaymnt        015JZQHXBALYR7T Center for Guided Montessori Studies Bill.com 01
- Reason: expense_refund
- Created by: usr_matthew_kramer at "2026-07-25T16:05:21.708Z"
- Note: (none)
- QBO accounts/categories: (none found)
- QBO payer(s): (none found)
- QBO evidence: [{"source":"bank_deposit_qbo_register","id":"bdqr_bdep_9758432a6823e4d50e53ceeb","bank_transaction_id":"bnk_846cbe85e5d2b7a8afe30873","amount":"6000.00","txn_date":"2025-08-12T00:00:00.000Z","txn_type":"Journal","ref_no":"BILL.com 08/12/25 CR","memo":"BILL 08/12/25 Credit P25050801 - 0877632","reconciliation_status":"Reconciled"}]

### bdep_ca687dcc605158617b885db6 — 200000.00 on "2026-05-05T00:00:00.000Z"
- Deposit memo: TRANSFER FROM BRK ****9888 REF# 624290930
- Reason: intercompany_transfer
- Created by: usr_matthew_kramer at "2026-07-25T20:48:31.798Z"
- Note: (none)
- QBO accounts/categories: 1004 BROKERAGE
- QBO payer(s): (none found)
- QBO evidence: [{"source":"bank_deposit_qbo_register","id":"bdqr_bdep_ca687dcc605158617b885db6","bank_transaction_id":"bnk_19b653843739e14eb5dadbec","amount":"200000.00","txn_date":"2026-05-05T00:00:00.000Z","txn_type":"Transfer","accounts":["1004 BROKERAGE"],"memo":"Transfer to Operating Account","reconciliation_status":"Reconciled"}]

### bdep_ce3a0723b64018278f8ff2a3 — 605.48 on "2025-11-07T00:00:00.000Z"
- Deposit memo: Bill.com         VoidPaymnt        015CNEPQOTQCD5E Center for Guided Montessori Studies Bill.com 01
- Reason: expense_refund
- Created by: usr_matthew_kramer at "2026-07-25T16:05:11.194Z"
- Note: (none)
- QBO accounts/categories: (none found)
- QBO payer(s): (none found)
- QBO evidence: [{"source":"bank_deposit_qbo_register","id":"bdqr_bdep_ce3a0723b64018278f8ff2a3","bank_transaction_id":"bnk_9ac8f8bc30f433d3263f7d32","amount":"605.48","txn_date":"2025-11-07T00:00:00.000Z","txn_type":"Journal","ref_no":"Bill.com CR_11_7_25","memo":"BILL 11/07/25 Credit P25080401 - 7634981","reconciliation_status":"Reconciled"}]

### bdep_cf625c83d803c283a9d3ab72 — 6508.00 on "2025-07-24T00:00:00.000Z"
- Deposit memo: Bill.com         VoidPaymnt        015GLUUCECL29XU Center for Guided Montessori Studies Bill.com 01
- Reason: expense_refund
- Created by: usr_matthew_kramer at "2026-07-25T16:06:32.671Z"
- Note: (none)
- QBO accounts/categories: (none found)
- QBO payer(s): (none found)
- QBO evidence: [{"source":"bank_deposit_qbo_register","id":"bdqr_bdep_cf625c83d803c283a9d3ab72","bank_transaction_id":"bnk_4f2790eb3730a59f0b9f55dc","amount":"6508.00","txn_date":"2025-07-24T00:00:00.000Z","txn_type":"Journal","ref_no":"Bill.com Credit 7/24","memo":"BILL 07/24/25 Credit P25041801 - 7245043","reconciliation_status":"Reconciled"}]

### bdep_d77de48b49a28f5f5ae8ad2c — 2675.89 on "2025-10-23T00:00:00.000Z"
- Deposit memo: Bill.com         Receivable        015ZHQBGTWPK38C Jun Zi Lan Montessori School, Inc. Bill.com 015Z
- Reason: earned_income
- Created by: usr_matthew_kramer at "2026-07-25T16:04:58.069Z"
- Note: (none)
- QBO accounts/categories: (none found)
- QBO payer(s): (none found)
- QBO evidence: [{"source":"bank_deposit_qbo_register","id":"bdqr_bdep_d77de48b49a28f5f5ae8ad2c","bank_transaction_id":"bnk_63ac3f6664f5b6669641dd0d","amount":"2675.89","txn_date":"2025-10-23T00:00:00.000Z","txn_type":"Journal","ref_no":"PPD Exp Sep 2027","memo":"BILL 10/23/25 AR Payments","reconciliation_status":"Reconciled"}]

### bdep_de9d92882fa6811435cf7ec2 — 200000.00 on "2025-12-17T00:00:00.000Z"
- Deposit memo: TRANSFER FROM BRK ****9888 REF# 606495171
- Reason: intercompany_transfer
- Created by: usr_matthew_kramer at "2026-07-25T20:49:54.404Z"
- Note: (none)
- QBO accounts/categories: 1004 BROKERAGE
- QBO payer(s): (none found)
- QBO evidence: [{"source":"bank_deposit_qbo_register","id":"bdqr_bdep_de9d92882fa6811435cf7ec2","bank_transaction_id":"bnk_d614f8cc099f25fe4181bd70","amount":"200000.00","txn_date":"2025-12-17T00:00:00.000Z","txn_type":"Transfer","accounts":["1004 BROKERAGE"],"reconciliation_status":"Reconciled"}]

### bdep_e8d8cdc41a04805b2239cd97 — 6179.08 on "2025-12-12T00:00:00.000Z"
- Deposit memo: DC WILDFLOWER PU EFT PYMT   121125 Charter School  The Wildflower Foundat
- Reason: earned_income
- Created by: usr_matthew_kramer at "2026-07-25T16:04:22.191Z"
- Note: (none)
- QBO accounts/categories: 1503 Pledges/Services Receivable
- QBO payer(s): DC Wildflower Public Charter School
- QBO evidence: [{"source":"bank_deposit_qbo_register","id":"bdqr_bdep_e8d8cdc41a04805b2239cd97","bank_transaction_id":"bnk_ff066264247a793182c86a32","amount":"6179.08","txn_date":"2025-12-12T00:00:00.000Z","txn_type":"Payment","ref_no":"11122872","payer":"DC Wildflower Public Charter School","accounts":["1503 Pledges/Services Receivable"],"reconciliation_status":"Reconciled"}]

## What is judgment versus reproducible derivation

- Pure judgment: the 16 active human-created deposit exclusions; their creator, note, reason, and evidence are preserved verbatim. Coding-form rows with gift mappings preserve form/match decisions; the explicitly confirmed subset is counted above.
- Rule-derived and reproducible: the 652 active exclusions with created_by_user_id IS NULL, which can be regenerated from the 0185 account classification rule and its fixed reviewed input set. The 0185 SQL was a one-time reviewed backfill, so the registry preserves the resulting rows and evidence rather than treating the classifier as a current auto-write authority.
- Evidence links: source_links is the evidence↔evidence authority. The registry records every current link with both endpoints resolved in charge_qb_ties.csv; provenance/lifecycle identify human-confirmed versus system/backfilled claims.
- Legacy repair evidence: the seven bdc_0172_* component rows are historical hand-repair artifacts captured in legacy_0172_components.csv, not clean machine-rebuild rules.
- Coding-form mappings: coding_form_rows is the durable review staging authority for imported form decisions. coding_form_mappings.csv includes every row with a matched gift, including raw form JSON, decisions, overrides, confirmation, and applied-state fields.

## Files

- exclusions.csv — all active deposit-level exclusions with QBO accounts, payers, and evidence.
- payment_applications.csv — every payment-application row with canonical payment-unit evidence and gift details.
- charge_qb_ties.csv — every source_links row with resolved evidence endpoints.
- legacy_0172_components.csv — all seven legacy 0172 component rows and their gift applications.
- coding_form_mappings.csv — all coding-form rows that map to a gift.
- cluster_resolutions.csv — the 46 same-day/same-donor register clusters that matched no cluster-sum deposit, resolved via Wells Fargo bank cross-check (2026-07-23): 30 clusters are separate physical deposits (one per register row, each row matched to its own same-day bank deposit incl. payer identity — JPMorgan = Excellent Schools New Mexico $60k + Broadstreet Impact Services $1,050; NYC guaranty = two separate $4,523.02 Bill.com payments; Morgan Stanley = separate monthly Dahlia Montessori repayment ACHs; all Stripe clusters = separate ST- transfers); 3 owner-ruled single gift with two allocations (Strategic Grant Partners $325k, Spring Point Partners $100k, Sep Kamvar $67,031.70); 1 partial bank match (MN Dept of Revenue 2025-04-14); 12 unresolved with no bank rows found in the exports.
