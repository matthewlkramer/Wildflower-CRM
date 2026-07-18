# 0133 — Bulk resolution of the coding-form review queue

**Date judged:** 2026-07-18 · **Rows:** 269 pending prod `coding_form_rows`

| Outcome | Count | What the SQL does |
|---|---|---|
| Confirmed (matcher verified) | 161 | stamps `match_confirmed_at/by` + per-attribute `decisions` |
| Confirmed (hand-matched) | 8 | also sets donor + `matched_gift_id` (method=manual, tier=high) |
| Donor pre-filled, stays pending | 18 | sets donor only — gift isn't booked yet, so no confirm |
| Skipped (non-donations + 1 duplicate) | 27 | `status='skipped'` |
| Matching QB rows excluded | 2 | `staged_payments.exclusion_reason` set (rest were already excluded) |
| Left pending for a human | 55 | untouched — reasons listed below |

**Confirmer:** all confirmations are stamped `usr_matthew_kramer`. To attribute to Erica
instead, find-replace `usr_matthew_kramer` in the SQL before running.

## How to ship

1. Review this report (especially "Judgment calls" and the hand-matched section).
2. **Publish** (ships the bulk endpoint; no schema change in this task).
3. From the repo root:
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0133_bulk_resolve_coding_form_rows.sql
   ```
   The final SELECT prints verification counts (expected values are commented above it).
4. In the app: Coding forms → **Apply decided** — runs the normal apply path for every
   confirmed row (writes purpose/restriction/circle/memo tags/report deadlines to the
   matched gifts, opportunities and allocations).
5. Then **Pull grant agreements** as planned.

## Donor-intent policy (owner rules, 2026-07-18) — overrides the coding-form text

The decisions below were re-audited against four owner rules. Where a rule and the
form answer disagree, the rule wins:

1. **Yield gift + anything from Arthur Rock: NEVER donor-restricted** (always
   unrestricted or Wildflower-designated). No confirmed rows were affected — every
   Arthur Rock row (fy25_0, fy25_109, fy25_110, fy26_107, fy26_108, fy26_109) is
   pending or donor-only. Whoever resolves them by hand: do NOT apply any
   restriction, whatever the form says.
2. **Anything for BWF / Black Wildflowers Fund is donor-restricted**, even when the
   form says gen-ops/unrestricted. 6 rows flipped to apply the usage-restriction
   axis: fy24_43 (Bainum "no", but the memo says this half is for BWF), fy24_44
   ("intended for BWF but not restricted"), fy24_50 (William Penn match for BWF),
   fy25_5 ("Intended for BWF gen op"), fy25_13 (Common Future BWF grant, form says
   "No"), fy26_102 ("Yes, to BWF"). Note on fy25_13: the AI layer had flagged its
   restriction answer as junk, which would have suppressed the cross-check and
   silently dropped the flip — the SQL includes a guarded un-junk UPDATE for this
   row so the decision actually acts.
3. **Anything for a regional hub is geo-restricted to its region**, regardless of the
   form. 54 rows flipped to apply the hub→region write (appends the region and sets
   the regional axis to donor-restricted): the MN gen-op block (fy24_14/32/35/46,
   fy25_37/104, fy26_29/74–81/83/88/89/90/92/93/95/96/103 — the gaps in that FY26
   span are rows that were not hub-circle confirms), the PR/Girasol rows (fy24_19/42/47,
   fy25_28/33/38/44/47/48/50/51/52/66, fy26_47/48, girasol 1/4/6/7/8/9/10/11 — incl.
   the two hand-matched rows fy24_32 and girasol_1, whose flips live in the SQL
   only), and Colorado/Mid-Atlantic (fy24_29/31, fy25_4/31/41/53, fy26_68).
   Exception: fy24_37 "general operating for NJ work" sits in the Radicle circle — a
   cohort, not a geography — so there is no region to map; left unflipped.
4. **Donorbox designations are authoritative** (straight from the donor: "growth in
   DC" → DC geo-restricted; hurricane relief / MN immigrant families → restricted to
   those projects). No row in this queue carries an unapplied Donorbox designation —
   the Donorbox BWF rows already apply — but the rule governs future queue reviews.

Rules 2–4 also bind the rows left pending/donor-only (e.g. fy24_36 NBCDI-for-BWF,
fy24_33 + fy25_103 MN gen-op, fy24_39 Mid-Atlantic, fy24_12 + fy25_2 DC hub,
fy24_21/22 Colorado/Minnesota): when a human confirms them later, apply the matching
restriction even if the form says unrestricted.

## Other judgment calls to sanity-check

- **Outside rules 1–4, "not restricted" answers do NOT latch donor-restricted.**
  Negation answers ("no", "unrestricted", "not restricted but…", "gen op") on
  non-BWF, non-hub rows still apply nothing to the usage axis, e.g. fy24_16 "no -
  designated but not restricted", fy24_40 "No - gen op support", fy25_43
  "unrestricted to Wildflower", fy25_7 "Not restricted but… Seed fund".
- **"Yes to BWF"-style answers DO latch donor-restricted** (the submitter answered yes to
  the restriction question), incl. "only to BWF, not by purpose".
- **Addresses:** applied only when the CRM had none (78 rows); conflicting addresses were left alone.
- **Regional restriction:** now applied on 56 rows (2 original + 54 under rule 3).
  Append-the-region semantics: existing allocation regions are kept, the hub region
  is added once, and the regional axis latches to donor-restricted.
- **Amy Gips** appears as BOTH a person and an organization — the person record was used
  (it books the $15k gift); the org record looks like a duplicate worth merging.

## 1. Hand-matched confirms (8) — review these first

| Row | Sheet says | Matched to | Gift | Why |
|---|---|---|---|---|
| FY24 row 32 | Marge Barrett (Rogers Foundation) $5,000.00 | Patrick & Alice Rogers Family Foundation | Marge Barrett FY24 Renewal | gift "Marge Barrett FY24 Renewal" $5,000 under the Rogers Family Foundation — name/FY/amount all line up |
| FY25 row 55 | Philip and Tina Vasan (via Vanguard DAF) $500.00 | Philip Vasan | FY25 Phil Vasan $500 Donation | gift "FY25 Phil Vasan $500 Donation" 2025-01-15 vs Vanguard check 12/27/24 |
| FY26 row 26 | Morgan Stanley DAF owned by Nic and Lindsey Barnes $10,000.00 | Nic and Lindsey Barnes | $10,000 Barnes DAF gift FY26 for Dahlia El | gift "$10,000 Barnes DAF gift FY26 for Dahlia El" 2025-11-05 — exact match |
| FY26 row 42 | Melanie Dukes via Fidelity Charitable DAF (Dukes Family Fund) $2,500.00 | Melanie Dukes | FY26 Dukes BWF $2500 | gift "FY26 Dukes BWF $2500" 2025-12-12 — exact match |
| FY26 row 55 | Amy Buckley $522.24 | Amy Hertel Buckley | FY26 Amy Buckley $500 donation | gift "FY26 Amy Buckley $500 donation" 2025-12-22 books at $522.24 gross (Donorbox fee-covered) |
| FY26 row 64 | Janet and Roger Begin $100.00 | Janet Begin | FY26 Begin $100 to BWF | gift "FY26 Begin $100 to BWF" dated 2026-01-07, same day as the row |
| GIRASOL row 0 | Han Kao and Kaye Quema Kao $5,000.00 | Hanhwa Kao | $5,000 Kao check #1 FY25 | gift "Kao check #1 FY25" $5,000 2024-10-03 vs row 2024-10-01 |
| GIRASOL row 1 | Han Kao and Kaye Quema Kao $5,000.00 | Hanhwa Kao | $5,000 Kao check #2 FY25 | gift "Kao check #2 FY25" $5,000 2024-10-03 vs row 2024-10-01 |

## 2. Donor pre-filled, left pending (18) — gift not booked yet

These stay in the queue: the money isn't in the CRM as a gift yet (mostly checks that
predate QuickBooks sync coverage or aren't deposited). The donor is stamped so a later
reviewer only has to attach the gift.

| Row | Sheet says | Donor stamped | Note |
|---|---|---|---|
| FY24 row 30 | LISC $8,578.61 | Early Milestones (CO LISC) | LISC/Colorado funder; no $8,578.61 gift booked yet |
| FY24 row 33 | McKnight Foundation (Dana Anderson) $25,000.00 | McKnight Foundation | clean org match; no $25,000 gift booked yet |
| FY24 row 36 | NBCDI $540.00 | National Black Child Development Institute | NBCDI = National Black Child Development Institute; no $540 gift booked yet |
| FY24 row 39 | Spring Point $5,000.00 | Spring Point Partners | clean org match; no $5,000 gift booked yet |
| FY25 row 103 | Frey Foundation (via St. Paul + Minnesota Foundation) $60,000.00 | Frey Foundation | clean org match; no $60,000 gift booked yet |
| FY25 row 34 | Lars + Becky Klevan via Schwab Charitable $250.00 | Lars and Becky Klevan | household matched via FY23 "$250 Schwab DAF Klevan gift"; FY25 $250 gift not booked yet |
| FY25 row 39 | Amy Gips / Fidelity Charitable DAF $5,000.00 | Amy Gips | person matched (books the "$15,000 AG to BWF" gift); NOTE: a separate org record "Amy Gips" also exists — possible duplicate; no $5,000 gift booked yet |
| FY26 row 108 | Arthur Rock (via Vanguard Charitable) $150,000.00 | Arthur Rock | gave via Vanguard Charitable (person, not the company); $150k BWF slice of a larger gift not booked yet |
| FY26 row 19 | Allen + Carolina Vasan $5,000.00 | Allen Vasan | person matched via 2020 gift; no FY26 $5,000 Seed Fund gift booked yet |
| FY26 row 21 | Lars and Becky Klevan / DAFGiving360 $500.00 | Lars and Becky Klevan | same household as FY25 row; FY26 $500 gift not booked yet |
| FY26 row 25 | Cisco via Benevity $10,000.00 | Cisco / Cisco Foundation | employee-match donor; no $10,000 Cisco gift booked yet (the $10k FY26 gift is the Barnes DAF gift, matched to cfr_fy26_26) |
| FY26 row 58 | Fidelity Foundations (prefers to be Anonymous in public facing documents) $15,000.00 | Fidelity Foundations | $15,000 slice of the $80,000 Inkwell grant; no matching gift booked yet |
| FY26 row 59 | Fidelity Foundations (They prefer to remain Anonymous in public facing documents) $65,000.00 | Fidelity Foundations | $65,000 slice of the $80,000 Inkwell grant; no matching gift booked yet |
| FY26 row 6 | Loyola University Maryland's Center for Montessori Education $2,088.00 | Loyola University Maryland | Center for Montessori Education sits under Loyola University Maryland; no $2,088 gift booked yet |
| FY26 row 61 | The Scholler Foundation (paid by The Glenmede Trust) $5,000.00 | Scholler Foundation (of Philadelphia) | memo says "for work in PA / the MidAtlantic" — the Philadelphia Scholler; no FY26 $5,000 gift booked yet |
| FY26 row 70 | Jacqui Miller $104.70 | Jacqueline Miller | name match; candidate gift "MILLER 104.7" is 2025-12-31 vs row 2026-02-23 — likely a different monthly payment, gift left unmatched |
| FY26 row 91 | James Cantoni $104.70 | Jim and Gretchen Cantoni | name match (Jim=James); candidate gift 2026-02-12 vs row 2026-03-11 — likely a different monthly payment, gift left unmatched |
| FY26 row 99 | Gary Community Ventures $500.00 | Gary Community Investments | Gary Community Ventures = Gary Community Investments; no $500 gift booked yet |

## 3. Skipped (27)

| Row | Sheet says | Reason |
|---|---|---|
| FY24 row 26 | IRS Credit $4,133.58 | IRS employee-retention credit refund — not a donation |
| FY24 row 49 | WeWork — | WeWork service-retainer refund — not a donation |
| FY25 row 1 | IRS Credit $4,133.58 | IRS credit refund (same 941 credit as the FY24 sheet row) — not a donation |
| FY25 row 10 | Cosmos $1,567.09 | school membership fee (invoice) — not a donation |
| FY25 row 11 | Sweet Pea $500.00 | school fee invoice — not a donation |
| FY25 row 14 | IRS - not a donor $5,021.50 | IRS check; submitter marked "not a donor" |
| FY25 row 15 | Cactus Bloom (not a donor - school paying membership fee) $454.55 | school contribution/membership payment — not a donation |
| FY25 row 16 | Meadow Rue (C) — | school membership-fee ACH — not a donation |
| FY25 row 17 | mountain juniper $545.45 | school contribution payment — not a donation |
| FY25 row 18 | Wildflower New York Charter School — | school contribution ACH — not a donation |
| FY25 row 19 | DC WF PCS - Riverseed & Blue (not a donor) $3,945.85 | school contributions (Riverseed & Blue) — not a donation |
| FY25 row 20 | DCWPCS - Blue Montessori (not a donor) $454.55 | school contribution (Blue Montessori membership) — not a donation |
| FY25 row 21 | MWMS for Lirio Montessori (this is a school - not donor) $9,790.41 | school membership-fee invoices (Lirio) — not a donation |
| FY25 row 22 | MWMS for Water Lily (school - not a donor) $858.18 | school contribution (Water Lily invoice) — not a donation |
| FY25 row 23 | Han Kao and Kaye Quema Kao $10,000.00 | duplicate: this $10,000 (paid via 2 checks) is the same money as the two Girasol sheet rows matched to "Kao check #1/#2" |
| FY25 row 3 | We Are Rally, LLC $637.83 | We Are Rally LLC travel-expense reimbursement — not a donation |
| FY25 row 35 | N/A $3.00 | repayment of a personal charge on the Divvy card — not a donation |
| FY25 row 69 | State of MN (not a donor) $716.13 | State of MN tax refund; submitter marked "not a donor" |
| FY25 row 8 | The Riverseed School (via DC WF Public Charter School) — | school contribution August payment — not a donation |
| FY25 row 9 | Water Lily $858.18 | school contribution invoice — not a donation |
| FY26 row 0 | All the dollars — | test/junk submission ("All the dollars" / "yay") |
| FY26 row 106 | Minnesota Unemployment Insurance $2,623.65 | MN unemployment-insurance overpayment refund — not a donation |
| FY26 row 16 | IRS (not a donor) $4,532.48 | IRS Form 941 refund — not a donation |
| FY26 row 30 | The Hartford (workers comp insurance) $2,982.00 | Hartford workers-comp premium refund — not a donation |
| FY26 row 32 | Jennifer Houghton (not a donor) $41.86 | staff member refunding a personal Divvy charge; marked "not a donor" |
| FY26 row 41 | IRS refund check $3,741.59 | IRS refund check — not a donation |
| FY26 row 65 | IRS $4,714.26 | IRS refund — not a donation |

### Matching QuickBooks rows

Per the rule "a non-donation coding form ⇒ its QB row gets excluded too": prod was checked
for staged QB rows matching every skip above. All but two were **already excluded** in the
reconciliation queue (membership / tax_refund / expense_refund / zero_amount). The SQL
excludes the remaining two:

- `g6Ad2qr2RNPSkCSgnTZPb` — We Are Rally $637.83 (2024-07-22) — travel-expense reimbursement mislabeled "Donation" → `expense_refund`
- `OnHtz0il_QXi68OtEm2_n` — IRS check $5,021.50 (deposit 2024-08-30) — submitter marked "not a donor" → `tax_refund`

## 4. Left pending for a human (55)

| Row | Sheet says | Why it needs you |
|---|---|---|
| FY24 row 12 | DC Wildflower Public Charter School (DCWFPCS) $3,182.00 | donor matched but no gift at $3182 — likely not yet booked |
| FY24 row 20 | Gates Family Foundation $25,000.00 | donor matched but no gift at $25000 — likely not yet booked |
| FY24 row 21 | Hub: Colorado — | malformed row: no amount; memo names Gates Family Foundation — needs manual re-entry |
| FY24 row 22 | Hub: Minnesota — | malformed row: no amount; memo names Sauer Family Foundation ("check already received") — needs manual re-entry |
| FY24 row 38 | Scholler Foundation $5,000.00 | two Scholler Foundation orgs exist (Philadelphia vs Saint Paul & MN); memo "Poinciana start up" doesn't disambiguate |
| FY25 row 0 | Arthur Rock $1,500,000.00 | donor matched but no gift at $1500000 — likely not yet booked |
| FY25 row 108 | Stand Together Trust $500,000.00 | donor matched but no gift at $500000 — likely not yet booked |
| FY25 row 109 | Arthur Rock $1,000,000.00 | donor matched but no gift at $1000000 — likely not yet booked |
| FY25 row 110 | Arthur Rock $500,000.00 | donor matched but no gift at $500000 — likely not yet booked |
| FY25 row 12 | Bainum Family Foundation $150,000.00 | donor matched but no gift at $150000 — likely not yet booked |
| FY25 row 2 | DC Wildflower Public Charter School (DCWFPCS) $3,182.00 | donor matched but no gift at $3182 — likely not yet booked |
| FY25 row 26 | Robert Kinsman $5,000.00 | donor matched but no gift at $5000 — likely not yet booked |
| FY25 row 27 | Robert Kinsman- Kinsman & Krause Law Firm $5,000.00 | donor matched but no gift at $5000 — likely not yet booked |
| FY25 row 29 | ACUDEN $15,000.00 | ACUDEN (PR government agency) is not in the CRM — create the org first ($15,000, PR-restricted) |
| FY25 row 30 | ACUDEN $3,500.00 | ACUDEN is not in the CRM — create the org first ($3,500, PR-restricted) |
| FY25 row 40 | Spencer Burns $10,000.00 | donor matched but no gift at $10000 — likely not yet booked |
| FY25 row 45 | Sinha Kikeri Fund at Vanguard Charitable $500.00 | "Sinha Kikeri Fund at Vanguard Charitable" — only person "Meera Sinha" exists; donor record unclear |
| FY25 row 49 | Tom and Sarah Clark ℅ Timber Capital LLC $10,000.00 | Tom & Sarah Clark $10,000 to Girasol: near-exact gift recvgqf4iQuNUWYTv (2025-01-09, $10,000, Girasol) is booked under household "Abinadi and Diana Barrientos" — booking conflict needs a human |
| FY25 row 6 | Dr. Erika McDowell (not a donation) $141.68 | donor matched but no gift at $141.68 — likely not yet booked |
| FY25 row 60 | Vladimir and Chia Rodeski $5,000.00 | donor matched but no gift at $5000 — likely not yet booked |
| FY25 row 61 | Coulter Financial Services, LLC $52.37 | donor matched but no gift at $52.37 — likely not yet booked |
| FY25 row 64 | American Online Giving Foundation $3,500.00 | donor matched but no gift at $3500 — likely not yet booked |
| FY25 row 70 | Erica Cantoni $6.00 | donor matched but no gift at $6 — likely not yet booked |
| FY25 row 71 | Erica Cantoni $6.00 | donor matched but no gift at $6 — likely not yet booked |
| FY25 row 72 | Erica Cantoni $1,041.00 | donor matched but no gift at $1041 — likely not yet booked |
| FY25 row 73 | Anonymous Donor $100.00 | donor matched but no gift at $100 — likely not yet booked |
| FY25 row 74 | Zita Blankenship $200.00 | donor matched but no gift at $200 — likely not yet booked |
| FY25 row 75 | Erica Cantoni $6.00 | donor matched but no gift at $6 — likely not yet booked |
| FY25 row 78 | Alia Peera $26.00 | donor matched but no gift at $26 — likely not yet booked |
| FY25 row 83 | Jasmine Williams $30.00 | donor matched but no gift at $30 — likely not yet booked |
| FY25 row 99 | Mike Esposito $5.00 | donor matched but no gift at $5 — likely not yet booked |
| FY26 row 10 | Anonymous $20,071.51 | anonymous $20,071.51 stock gift for the Seed Fund — no donor record, needs a human |
| FY26 row 100 | Alexander Brown $150.00 | donor matched but no gift at $150 — likely not yet booked |
| FY26 row 104 | Alexander Brown $150.00 | donor matched but no gift at $150 — likely not yet booked |
| FY26 row 107 | Arthur Rock $1,150,000.00 | donor matched but no gift at $1150000 — likely not yet booked |
| FY26 row 109 | Arthur Rock $300,000.00 | donor matched but no gift at $300000 — likely not yet booked |
| FY26 row 11 | DC Wildflower Public Charter School $24,965.00 | donor matched but no gift at $24965 — likely not yet booked |
| FY26 row 14 | The Bainum Family Foundation $100,000.00 | donor matched but no gift at $100000 — likely not yet booked |
| FY26 row 15 | The Bainum Family Foundation $100,000.00 | donor matched but no gift at $100000 — likely not yet booked |
| FY26 row 18 | Excellent Schools New Mexico $1,292.57 | donor matched but no gift at $1292.57 — likely not yet booked |
| FY26 row 28 | Erica Cantoni $20.00 | donor matched but no gift at $20 — likely not yet booked |
| FY26 row 31 | Jennifer Houghton — | donor matched but no gift at $null — likely not yet booked |
| FY26 row 50 | Yohance Fuller $1,000.00 | donor matched but no gift at $1000 — likely not yet booked |
| FY26 row 60 | Diana Barrientos / Barrientos Family $10,000.00 | donor matched but no gift at $10000 — likely not yet booked |
| FY26 row 66 | Tosha Downey / DAFGiving360 $500.00 | donor matched but no gift at $500 — likely not yet booked |
| FY26 row 67 | Keith Tom / Daffy Charitable Fund $50,000.00 | date gap 409d: sheet 2026-01-16 vs gift 2024-12-03 |
| FY26 row 7 | Erica Cantoni $25.00 | donor matched but no gift at $25 — likely not yet booked |
| FY26 row 8 | Matt Kramer $3.00 | donor matched but no gift at $3 — likely not yet booked |
| FY26 row 82 | Inspired Minds Collide $514.41 | donor matched but no gift at $514.41 — likely not yet booked |
| FY26 row 87 | Lizzette Sauque $5,000.00 | donor matched but no gift at $5000 — likely not yet booked |
| FY26 row 9 | Matt Kramer $50.00 | donor matched but no gift at $50 — likely not yet booked |
| FY26 row 94 | Angie Schiavoni $261.28 | donor matched but no gift at $261.28 — likely not yet booked |
| GIRASOL row 2 | Robert Kinsman $5,000.00 | donor matched but no gift at $5000 — likely not yet booked |
| GIRASOL row 3 | Robert Kinsman- Kinsman & Krause Law Firm $5,000.00 | donor matched but no gift at $5000 — likely not yet booked |
| GIRASOL row 5 | Tom and Sarah Clark ℅ Timber Capital LLC $10,000.00 | same money as cfr_fy25_49 (Clark $10,000 to Girasol) — candidate gift is booked under the Barrientos household; resolve together |

## 5. Confirmed matcher suggestions (161)

Donor + gift/opportunity suggestions the matcher already made, verified offline against the
sheet (amount, date, name, fiscal year). The decisions column is what "Apply decided" will write.

| Row | Sheet says | Donor | Matched | Decisions |
|---|---|---|---|---|
| FY24 row 10 | Common Future $250.00 | recgkkqmXcEhlBUVv | gift: FY24 $250 accelerator stipend | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY24 row 14 | Douglass Brandenborg Family Foundation $60,000.00 | recJe1jM2ZxwHbQBw | gift: Brandenborg FY24 Renewal | apply: regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction |
| FY24 row 16 | Fidelity Foundations $350,000.00 | rec56v5anV8D4xP9l | gift: FY24 Anon MA Grant $350,000 (SSJ Phase II) | apply: reportDeadline, purposeVerbatim, circle, seriesType, additionalNotes, internalMemo · skip: usageRestriction, address |
| FY24 row 19 | Fundación Banco Popular $30,000.00 | recXNGcwyRuUo8vGd | gift: FY24 Banco Popular | apply: reportDeadline, purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, internalMemo |
| FY24 row 23 | Imaginable Futures $300,000.00 | recYkXr1waYSGZanu | gift: FY24 Imaginable Futures $300k to BWF | apply: reportDeadline, purposeVerbatim, usageRestriction, intendedUsage, address, circle, seriesType, additionalNotes, internalMemo |
| FY24 row 24 | Imaginable Futures $300,000.00 | recYkXr1waYSGZanu | gift: FY25 Imaginable Futures $300,000 to Black Wildflowers Fund | apply: reportDeadline, purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY24 row 25 | Imaginable Futures $500,000.00 | recYkXr1waYSGZanu | gift: FY25 Imaginable Futures $500,000 grant to Wildflower | apply: reportDeadline, address, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction |
| FY24 row 27 | Kellie Brown $240.00 | recUg5dbcAM7E7mZM | gift: $240 FY24 donation to Black Wildflowers Fund | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY24 row 28 | Krishnan Sampath $5,000.00 | recsK6O9mFzpwSY8t | gift: FY24 $5000 Sampath Donation | apply: circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY24 row 29 | LISC $40,000.00 | rec1CB47gTxjD01FR | opp: LISC PRI or grant | apply: regionalRestriction, address |
| FY24 row 31 | LISC $17,750.00 | rec14pJ2GxEA8rDBL | gift: Q3 FY24 LISC CO Reimbursement $17,750 | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, internalMemo · skip: intendedUsage |
| FY24 row 34 | Montessori Northwest $3,750.00 | recv3yWDxEVB7sqLD | gift: FY24 Black Wildflowers Fund $3,750 Donation | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY24 row 35 | Mortenson Family Foundation $4,000.00 | recIDJIhAo1tuXS3A | gift: Mortenson FY24 Gift $4,000 | apply: regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction |
| FY24 row 37 | Overdeck Family Foundation $60,000.00 | recSwPSZWJEXI7ye2 | gift: Overdeck $60,000 FY24 gift | apply: reportDeadline, purposeVerbatim, circle, seriesType, additionalNotes, internalMemo · skip: usageRestriction, address |
| FY24 row 40 | Stand Together Trust $500,000.00 | recSv5y0mG6ZQGFBX | gift: Stand Together FY24 | apply: purposeVerbatim, address, circle, seriesType, additionalNotes, internalMemo · skip: usageRestriction |
| FY24 row 41 | Stand Together Trust $500,000.00 | recSv5y0mG6ZQGFBX | gift: Stand Together FY25 | apply: address, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction |
| FY24 row 42 | The 20/22 Act Society $10,000.00 | recRGn3fb67g5TCuH | gift: FY24 $10,000 Training Grant | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY24 row 43 | The Bainum Family Foundation $50,000.00 | recykXYoQ7gJhNeoE | gift: FY24 Black Wildflowers Fund $50,000 | apply: reportDeadline, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, address |
| FY24 row 44 | The McKnight Foundation $10,000.00 | rec5hHTZtAvHDAAou | gift: FY24 McKnight to BWF $10,000 | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY24 row 45 | The Yass Prize $100,000.00 | rechBkBNQM8J2B6do | gift: Yass Prize 2023 $100,000 Award | apply: reportDeadline, purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY24 row 46 | WEM $250,000.00 | rec3AIEdNLQSpTAfb | gift: WEM Foundation Grant to MN $250k | apply: regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction |
| FY24 row 47 | WEND Collective $200,000.00 | recb7IVIo9rzCST5M | gift: Wend PR FY24 | apply: reportDeadline, purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY24 row 48 | Wend Collective $40,000.00 | recb7IVIo9rzCST5M | gift: FY24 $40,000 Wend to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY24 row 50 | William Penn Foundation $480.00 | recmpIhNf83IrqWI1 | gift: William Penn Foundation | apply: usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 100 | Erica Cantoni $500.00 | reczTuMKDMJjQpg5z | gift: FY25 $500 to Wildflower | apply: circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY25 row 101 | Beverlee Mendoza $50.00 | recLgHSkehPspjN48 | gift: $50 FY25 Mendoza to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 102 | Dionne Kirby $200.00 | recwTcVIeS6VCL7Lh | gift: FY25 Kirby to BWF #2 $200 | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 104 | The McKnight Foundation $10,000.00 | rec5hHTZtAvHDAAou | gift: FY25 McKnight $10,000 | apply: purposeVerbatim, regionalRestriction, circle, seriesType, internalMemo · skip: usageRestriction, address |
| FY25 row 105 | Inspired Minds Collide LLC / Dr. Erika McDowell $2,000.00 | recOCgtncqvV7ad1g | gift: $2,000 FY25 BWF Donation | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 106 | Education Leaders of Color $100,000.00 | recZvSmirPRO5lk3s | gift: FY25 Boulder Fund $100,000 | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 107 | ANONYMOUS - Amy Gips/Fidelity $15,000.00 | Amy Gips | gift: $15,000 AG to BWF FY25 #2 | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 13 | Common Future $25,000.00 | recgkkqmXcEhlBUVv | gift: FY24 BWF $25,000 Accelerator Grant #2 | apply: usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 24 | Imaginable Futures $500,000.00 | recYkXr1waYSGZanu | gift: FY26 Imaginable Futures Nation Dev $500,000 | apply: reportDeadline, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 25 | Imaginable Futures $300,000.00 | recYkXr1waYSGZanu | gift: FY26 Imaginable Futures BWF $300,000 | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 28 | ACUDEN $1,500.00 | reckjxiH33tdtOQiW | gift: $1500 FY25 Meeker Rom for Rosebay | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 31 | Local Initiatives Support Corporation (LISC) $1,721.39 | rec1CB47gTxjD01FR | opp: LISC PRI or grant | apply: regionalRestriction, address |
| FY25 row 32 | Allen Vasan $500.00 | Allen Vasan | gift: FY25 $500 Vasan Donation | apply: circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY25 row 33 | Fundación Banco Popular $30,000.00 | recXNGcwyRuUo8vGd | gift: FY25 $30,000 Banco Popular for Camelia School | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: intendedUsage |
| FY25 row 36 | Patrick and Alice Rogers Family Foundation $5,000.00 | Patrick & Alice Rogers Family Foundation | gift: FY25 Barrett $5,000 via Rogers Foundation | apply: address, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction |
| FY25 row 37 | Douglass Brandenborg Family Foundation $60,000.00 | recJe1jM2ZxwHbQBw | gift: Brandenborg FY25 $60,000 Renewal | apply: purposeVerbatim, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: usageRestriction |
| FY25 row 38 | David McKnight $5,000.00 | recy9WtBRFTEIrSUp | gift: FY25 David McKnight Girasol $5000 Donation | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 4 | Local Initiatives Support Corporation (LISC) $4,237.50 | rec1CB47gTxjD01FR | opp: LISC PRI or grant | apply: regionalRestriction, address |
| FY25 row 41 | Scholler Foundation -- Glenmede Trust $4,000.00 | recpJVf8d3D7fDCad | gift: Scholler Foundation FY 2025 $4,000 | apply: regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, intendedUsage |
| FY25 row 42 | Fidelity Foundations $200,000.00 | rec56v5anV8D4xP9l | gift: FY25 $200,000 Anon MA SSJ Phase II/ Open Schools | apply: reportDeadline, purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 43 | Bainum Family Foundation $75,000.00 | recykXYoQ7gJhNeoE | gift: FY25 Bainum #2 to National $75,000 | apply: purposeVerbatim, intendedUsage, circle, seriesType, additionalNotes, internalMemo · skip: usageRestriction, address |
| FY25 row 44 | Aaron Augusten & Kristen Tronsky $5,000.00 | recbVW1CwSP4v78bG | gift: $5,000 FY25 Augusten/Tronsky gift to Girasol | apply: reportDeadline, purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 46 | The Scully Peretsman Fund via Vanguard Charitable $100,000.00 | recIJTPGCH2DtgplA | gift: Peretsman FY25 $100,000 | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 47 | THE 20/22 ACT SOCIETY $10,000.00 | recRGn3fb67g5TCuH | gift: FY25 $10,000 Act 20/22 Society | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 48 | Tom and Sarah Clark  Timber Capital LLC $6,780.00 | reck9nH8cCjBHHVsN | gift: $6,780 FY25 Timber Capital/Clark gift to Girasol | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: intendedUsage |
| FY25 row 5 | Angela Schiavoni $1,000.00 | recRCXN9REdI3Wg5c | gift: $1,000 Schiavoni to BWF FY25 | apply: purposeVerbatim, usageRestriction, intendedUsage, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 50 | Abinadi and Diane Barrientos $10,000.00 | Abinadi and Diana Barrientos | gift: $10,000 FY25 Barrientos gift to Girasol | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: intendedUsage |
| FY25 row 51 | Melanie Sue Spiegel $5,000.00 | recmVGuzlgrmB6wST | gift: $5000 FY25 Spiegel gift to Girasol | apply: purposeVerbatim, usageRestriction, regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: intendedUsage, address |
| FY25 row 52 | Micah Winkelspecht $5,000.00 | rec4QsTAuJ3QXuQdT | gift: $5000 Winkelspecht FY25 gift to Girasol | apply: purposeVerbatim, usageRestriction, regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: intendedUsage, address |
| FY25 row 53 | Buell Foundation $40,000.00 | recAhaoCFiAvjDVm6 | gift: FY25 WF CO $40,000 | apply: reportDeadline, regionalRestriction, circle, seriesType, internalMemo · skip: address |
| FY25 row 54 | Krishnan Sampath $5,000.00 | recsK6O9mFzpwSY8t | gift: FY25 $5,000 Sampath donation | apply: circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY25 row 56 | Janet Begin $100.00 | Janet Begin | gift: $100 FY25 Janet Begin donation to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 57 | Lindsay and Matt Haldeman $2,000.00 | recdz3InaVKbqVhv5 | gift: $2000 FY25 Haldeman for BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 58 | Amy Hertel Buckley $1,000.00 | Amy Hertel Buckley | gift: FY25 Hertel Buckley $1000 to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 59 | Zita Blankenship $200.00 | recbgDQl6P7V19TGl | gift: Zita FY25 $200 to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 62 | The Meeker Rom Family Foundation $1,500.00 | reckjxiH33tdtOQiW | gift: $1500 FY25 Meeker Rom for Rosebay | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 63 | Melanie Dukes $5,000.00 | Melanie Dukes | gift: $5000 FY25 Dukes sponsorship of The Exchange | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 65 | Reinvestment Fund / LaToshia DeVose $750.00 | rec0yUF6xfz4teFyu | gift: FY25 Reinvestment $750 BWF Sponsorship | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 66 | David McKnight $5,000.00 | recy9WtBRFTEIrSUp | gift: FY25 David McKnight Girasol $5000 Donation | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 67 | Maia Blankenship $1,400.00 | recUdeGVQKlHczo79 | gift: FY25 $1400 BWF Donation | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 68 | VA Montessori Association $300.00 | recNdB6fN3QqGNjqN | gift: $300 FY25 BWF sponsorship | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, internalMemo |
| FY25 row 7 | Avi Nash- Indira Foundation $100,000.00 | recR28K8Twq5uV8Q0 | gift: Avi Nash Seed Grant | apply: purposeVerbatim, address, circle, seriesType, additionalNotes, internalMemo · skip: usageRestriction |
| FY25 row 76 | Debi Sementelli $200.00 | recjMvNJVBMKLLfNh | gift: FY25 Sementelli $200 to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 77 | James Cantoni $250.00 | Jim and Gretchen Cantoni | gift: Jim Cantoni FY25 $250 to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 79 | Vanessa J. Hawthorne $116.00 | recdmP0SZL981Enay | gift: $116 FY25 Hawthorne to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 80 | Sara McDaniel $75.00 | rec0jxD40iZs1Rwcg | gift: $75 FY25 McDaniel to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 81 | Lisa Thomas $52.00 | recVHgerdVKWMjf4U | gift: $52 FY25 Lisa Thomas to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 82 | Alejandra Gallego $100.00 | recbXU5w8G8W8NR08 | gift: $100 FY25 Gallego to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 84 | Orien Barnes $156.00 | rec7DSIdezCiLpDTm | gift: $156 FY25 Orien Barnes to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 85 | Veronica Osorio $26.00 | recVdzlGxvETJZZZc | gift: $26 FY25 Osario to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 86 | (Anonymous Donor) Melva Legrand $156.00 | recrWhhKEVtUciSWQ | opp: $156 FY25 Legrand to BWF | apply: purposeVerbatim, usageRestriction, address |
| FY25 row 87 | Hilary Beard $100.00 | recsMAQN0CMh3I6mo | gift: $100 FY25 Beard to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 88 | (Anonymous Donor) Keinya Kohlbecker $25.00 | recvdulTcRnUYRbna | gift: $25 FY25 Kohlbecker to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 89 | Alicia Robinson $52.00 | recmG0Gw2lf7SifwA | gift: $52 FY25 Robinson to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 90 | Jacob Kurtz $75.00 | recG7VBTVhCLvXNhC | gift: $75 FY25 Kurtz to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 91 | Trabian Shorters $1,000.00 | reciUNdCBusOCM6W9 | gift: $1000 FY25 Shorter to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 92 | (Anonymous Donor) Dionne Kirby $156.00 | recrWhhKEVtUciSWQ | opp: $156 FY25 Legrand to BWF | apply: purposeVerbatim, usageRestriction, address |
| FY25 row 93 | Jamie Rue $156.00 | recBovpzr5OAX6O5y | gift: $156 FY25 Rue to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 94 | Zita Blankenship $500.00 | recbgDQl6P7V19TGl | gift: $500 FY25 Zita Blankenship to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY25 row 95 | Simone Webster $156.00 | recZWy3Ro3Ml1KjJv | gift: $156 FY25 Webster to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 96 | Ayeisha Seawright Moses $104.00 | rec9Kqn70xcXqM2Lq | gift: $104 FY25 Moses to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 97 | Stephanie Cherestal $50.00 | rec2LAetiOcfG1AmO | gift: $50 FY25 Cherestal to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY25 row 98 | (Anonymous Donor) Ariana Bray $150.00 | rec40rBlhv2V3YU7E | gift: $150 FY25 Bray to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 1 | Allen Vasan $3,000.00 | Allen Vasan | gift: FY26 Allen Vasan $3000 | apply: circle, seriesType, additionalNotes · skip: address |
| FY26 row 101 | Danielle Tucker $52.51 | recp6UBfqpSD01oC9 | gift: Tucker 52.51 2026-03-08T23:50:24.139Z | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 102 | LaTania Scott $50.00 | 5P8Z3pGo-0bxZege5U7ME | gift: LaTania Scott (Donor) | apply: usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY26 row 103 | Katherine Bradley $1,000.00 | recx1ifTLExCb887N | opp: Request for support for DC charter | apply: regionalRestriction, address |
| FY26 row 105 | Truist Foundation $90,000.00 | recXyHKniULRe5ZzT | gift: FY26 Truist $90,000 to BWF | apply: reportDeadline, purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 12 | Gregory Harrison $100.00 | recodFJZxJnfXWZQu | gift: FY26 Harrison $100 donation to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo |
| FY26 row 13 | Melvin Waits $200.00 | recYKN77UwhbIsM7f | gift: FY26 $200 Melvin Wait to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes |
| FY26 row 17 | William Penn Foundation $223,500.00 | recmpIhNf83IrqWI1 | gift: FY26 BWF $223,500 William Penn grant | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: allocationEntity, address |
| FY26 row 2 | One Hope Foundation $4.00 | recw3xGEgHdyUWIj6 | gift: FY26 $4 One Hope donation | apply: address, circle, seriesType, additionalNotes |
| FY26 row 20 | ANONYMOUS (Fidelity Charitable DAF Gift from Amy Gips) $125,000.00 | Amy Gips | gift: FY26 AG Anon $125,000 Seed Fund and GenOps | apply: circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 22 | Maia Blankenship $50.00 | recUdeGVQKlHczo79 | gift: FY26 Blankenship $50 to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes · skip: address |
| FY26 row 23 | Jim and Gretchen Cantoni $50.00 | Jim and Gretchen Cantoni | gift: Jim Cantoni $50 FY26 to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY26 row 24 | ANONYMOUS Amy Gips Family Fund at Fidelity $7,000.00 | Amy Gips | gift: FY26 AG Anon $7k BWF sponsorship | apply: usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, address |
| FY26 row 27 | Erica Cantoni $5.54 | reczTuMKDMJjQpg5z | gift: Cantoni 5.0 2025-11-13T15:37:54.738Z | apply: circle, additionalNotes |
| FY26 row 29 | Douglass Brandenborg Family Foundation $60,000.00 | recJe1jM2ZxwHbQBw | gift: FY26 $60,000 Brandenborg grant | apply: purposeVerbatim, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: usageRestriction |
| FY26 row 3 | Howley Foundation $120,000.00 | recamL8KTYrZONpIS | gift: Howley MidAtlantic FY26 $120k | apply: reportDeadline, purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: intendedUsage |
| FY26 row 33 | Zita Blankenship $574.43 | recbgDQl6P7V19TGl | gift: Blankenship $574 FY26 to BWF #1 | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 34 | Lisa Thomas $50.00 | recVHgerdVKWMjf4U | gift: Thomas 50.0 2025-12-02T16:34:45.492Z | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY26 row 35 | Beverlee Mendoza $26.41 | recLgHSkehPspjN48 | gift: Mendoza 26.41 2025-12-03T19:55:40.413Z | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 36 | Julianna Boye $10.00 | recfuVqr3HoWaJq60 | gift: boye 10.0 2025-12-03T16:29:03.549Z | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 37 | Hilary Beard $104.70 | recsMAQN0CMh3I6mo | gift: Beard 104.7 2025-12-03T15:53:06.194Z | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 38 | Candace Fletcher $50.00 | recvxJOwnEX1RyFwy | gift: Fletcher 50.0 2025-12-03T14:23:02.905Z | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 39 | Karla Rodríguez ore $50.00 | reckkt8Jpu5HbfZIP | gift: Rodríguez ore 50.0 2025-12-03T13:34:24.725Z | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 4 | Promise Venture Studios via Rockefeller Philanthropies $850.00 | recbJjrjExcIN1ZyX | gift: FY26 $850 Promise to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY26 row 40 | Ruth Melian $156.89 | recgCKuMrZ7v5y0em | gift: Melian 156.89 2025-12-04T09:12:06.705Z | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 43 | Trout Lily Initiative (via a Fidelity Charitable Donor Advised Fund) $25,000.00 | recf936vgy2XqEVd8 | gift: Trout Lily Initiative $25,000 BWF grant FY26 | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY26 row 44 | Sampath Krishnan $2,000.00 | recsK6O9mFzpwSY8t | gift: FY26 Sampath $2000 | apply: circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 45 | The Patrick & Alice Rogers Foundation $5,000.00 | Patrick & Alice Rogers Family Foundation | gift: FY26 Rogers Foundation $5,000 | apply: address, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction |
| FY26 row 46 | Transparent Classroom $2,500.00 | recVG0lspJZAYEjyg | gift: FY26 Transparent Classroom $2500 to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY26 row 47 | Vladimir and Chia Rodeski $2,500.00 | recP1ebGhDzgyCDd1 | gift: FY26 $2500 Rodeski to Girasol | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY26 row 48 | Foundation Banco Popular $30,000.00 | recXNGcwyRuUo8vGd | gift: FY26 Banco Popular $30,000 | apply: reportDeadline, purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY26 row 49 | Vladimir and Chia Rodeski $1,000.00 | recP1ebGhDzgyCDd1 | gift: FY26 #2 Rodeski $1000 | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY26 row 5 | Excellent Schools New Mexico $60,000.00 | reca1aY0uiWlzWwxp | gift: FY26 $60,000 Excellent Schools NM grant | apply: reportDeadline, purposeVerbatim, usageRestriction, address, circle, seriesType, internalMemo |
| FY26 row 51 | Carrie Horwitz Lang $522.24 | recs85Feq6KVb4QOd | gift: Horwitz Lang 522.24 2025-12-17T14:41:13.904Z | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 52 | Erica Cantoni $1,025.52 | reczTuMKDMJjQpg5z | gift: FY26 Cantoni $1025 to BWF | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 53 | Elizabeth Pawlson $100.00 | recWzroqBAZskBCyY | gift: Pawlson 100.0 2025-12-19T12:38:04.012Z | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 54 | Erica Cantoni $1,044.16 | reczTuMKDMJjQpg5z | gift: FY26 Cantoni $1044 to WF | apply: circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 56 | Alexandra Tyson $100.00 | reckfAxQDcpZBtCQr | gift: Tyson $100 FY26 to BWF | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY26 row 57 | Zita Blankenship $522.24 | recbgDQl6P7V19TGl | gift: Blankenship $522 FY26 to BWF #2 | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 62 | The Act 20/22 Society $20,000.00 | recRGn3fb67g5TCuH | gift: 20/22 Act FY26 | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo |
| FY26 row 63 | Maia Blankenship $1,109.81 | recUdeGVQKlHczo79 | gift: Fy26 BWF Blankenship $1109 | apply: purposeVerbatim, usageRestriction, intendedUsage, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 68 | Buell Foundation $40,000.00 | recAhaoCFiAvjDVm6 | gift: FY26 Buell $40,000 | apply: reportDeadline, purposeVerbatim, usageRestriction, regionalRestriction, circle, seriesType, internalMemo · skip: address |
| FY26 row 69 | Matt and Lindsay Haldeman $5,000.00 | recdz3InaVKbqVhv5 | gift: $5000 FY26 Haldeman to BWF | apply: purposeVerbatim, usageRestriction, intendedUsage, address, circle, seriesType, additionalNotes, internalMemo |
| FY26 row 71 | Marlene Fultz Cooper $150.00 | recXGMjPL7OryJspM | gift: Fultz Cooper 150.0 2026-01-24T16:34:10.035Z | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 72 | Meisha Perrin $261.28 | recKk1U5BfGDYJNka | gift: Perrin FY26 BWF $261 | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 73 | Paul Serotkin $150.00 | recSMzjv6GhNefJN6 | gift: FY26 $150 Serotkin | apply: circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 74 | Philip Vasan $1,044.16 | Philip Vasan | gift: FY26 Vasan $1044 to WF MN | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 75 | Neil Campbell $250.00 | rechkgUhD9YjAgDwe | gift: FY26 Campbell $250 to WF MN | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 76 | Sarah Muncey $50.00 | recDvLUrLFI4Sz0pp | gift: FY26 Muncey $50 to WF MN | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 77 | Maia Blankenship $104.70 | recUdeGVQKlHczo79 | gift: FY26 Blankenship $104 to WF MN | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 78 | Jeff Bradach $261.28 | recVcLA7TFQICx1Yh | gift: FY26 Bradach $261 to WF MN | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 79 | Massie Ritsch $209.09 | recX8A7FkEjkFAFJB | gift: FY26 Ritsch $209 to WF MN | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 80 | Michael Buman $100.00 | recY0gz8tw9ZnnpAr | gift: FY26 Buman $100 to WF MN | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 81 | Erica Cantoni $5.00 | reczTuMKDMJjQpg5z | gift: FY26 Cantoni $5 test | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 83 | Danielle Higa $50.00 | recgTRYPhcsJNoCSX | gift: FY26 Higa $50 to MN schools | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 84 | Dionne Kirby $50.00 | recwTcVIeS6VCL7Lh | gift: Kirby 50.0 2026-02-22T23:45:37.942Z | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 85 | Kathleen Rash $50.00 | recSschvF1pFzWrQH | gift: Rash 50.0 2026-02-26T00:55:07.262Z | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 86 | NaTasha Day $50.00 | recZUhh5OJ92h3T3Q | gift: Day 50.0 2026-03-04T17:35:21.470Z | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| FY26 row 88 | Kali DeCambra $25.00 | rec2unSi9ZC2r1sN6 | gift: FY26 DeCambra $25 to WF MN | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 89 | Sara Rogers $100.00 | recf9q0Aem5zgQB6O | gift: FY26 Sara Rogers $100 to MN WF | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 90 | Daniel Sellers $42.07 | recxIfSqs0eDFacz0 | gift: FY26 Sellers $42 to WF MN | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 92 | Sara Suchman $100.00 | recVWroDtZbAsfUBg | gift: FY 26 Suchman $100 to WF MN | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 93 | Shannon Rogers $1,000.00 | recxSINdT6Iux7TSa | gift: FY26 Rogers $1000 to WF MN | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 95 | Erica Cantoni $417.85 | reczTuMKDMJjQpg5z | gift: FY26 E Cantoni $417 to WF MN | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 96 | Nora Flood $261.28 | reca9mlJPn39fAxPb | gift: FY26 Nora Flood $250 donation to MN Support | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 97 | Clifford Bussie $52.51 | recUSO9QioQ3hM38g | gift: Bussie 52.51 2026-02-24T18:02:57.253Z | apply: regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address |
| FY26 row 98 | Fidelity Foundations (Anonymous) $175,000.00 | rec56v5anV8D4xP9l | gift: FY26 National Grant $175,000 | apply: reportDeadline, purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address |
| GIRASOL row 10 | David McKnight $5,000.00 | recy9WtBRFTEIrSUp | gift: FY25 David McKnight Girasol $5000 Donation | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle |
| GIRASOL row 11 | Vladimir and Chia Rodeski $7,000.00 | recP1ebGhDzgyCDd1 | gift: Rodeski FY25 $7,000 gift to Girasol | apply: purposeVerbatim, usageRestriction, regionalRestriction, circle, internalMemo · skip: intendedUsage |
| GIRASOL row 4 | Tom and Sarah Clark  Timber Capital LLC $6,780.00 | reck9nH8cCjBHHVsN | gift: $6,780 FY25 Timber Capital/Clark gift to Girasol | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, internalMemo · skip: intendedUsage |
| GIRASOL row 6 | Abinadi and Diane Barrientos $10,000.00 | Abinadi and Diana Barrientos | gift: $10,000 FY25 Barrientos gift to Girasol | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, internalMemo · skip: intendedUsage |
| GIRASOL row 7 | Melanie Sue Spiegel $5,000.00 | recmVGuzlgrmB6wST | gift: $5000 FY25 Spiegel gift to Girasol | apply: purposeVerbatim, usageRestriction, regionalRestriction, circle, internalMemo · skip: intendedUsage, address |
| GIRASOL row 8 | Micah Winkelspecht $5,000.00 | rec4QsTAuJ3QXuQdT | gift: $5000 Winkelspecht FY25 gift to Girasol | apply: purposeVerbatim, usageRestriction, regionalRestriction, circle, internalMemo · skip: intendedUsage, address |
| GIRASOL row 9 | Aaron Augusten & Kristen Tronsky $5,000.00 | recbVW1CwSP4v78bG | gift: $5,000 FY25 Augusten/Tronsky gift to Girasol | apply: reportDeadline, purposeVerbatim, usageRestriction, regionalRestriction, address, circle, internalMemo |

