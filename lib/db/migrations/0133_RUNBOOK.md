# 0133 — Bulk resolution of the coding-form review queue

**Date judged:** 2026-07-18 (first pass; second pass the same day re-judged the 73 rows
left pending, one by one against prod gifts) · **Rows:** 269 pending prod `coding_form_rows`

| Outcome | Count | What the SQL does |
|---|---|---|
| Confirmed (matcher verified) | 161 | stamps `match_confirmed_at/by` + per-attribute `decisions` |
| Confirmed (hand-matched, first pass) | 8 | also sets donor + `matched_gift_id` (method=manual, tier=high) |
| Confirmed (hand-matched, second pass) | 49 | same shape — section 6 of the SQL; 12 were donor-only in the first pass |
| Donor pre-filled, stays pending | 13 | 6 first-pass stamps + 2 IRS→US Treasury stamps; 5 verified matcher prefills need no write |
| Skipped (non-donations + duplicates) | 32 | `status='skipped'` (25 first pass + 7 second pass) |
| Matching QB rows excluded | 2 | `staged_payments.exclusion_reason` set (every second-pass skip's QB row was already excluded) |
| Left pending for a human | 6 | untouched — each carries a note below |

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
   unrestricted or Wildflower-designated). All six Arthur Rock rows (fy25_0,
   fy25_109, fy25_110, fy26_107, fy26_108, fy26_109) are now confirmed in the
   second pass (section 4) with every restriction attribute skipped, per this
   rule — whatever the form said.
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

Rules 2–4 were applied through the second pass as well (fy24_33 MN gen-op and
fy24_39 Mid-Atlantic are now confirmed with the matching flips). **One manual
follow-up:** the two malformed "Hub:" rows fy24_21 (Gates Family Foundation $95,000,
Colorado) and fy24_22 (Sauer Family Foundation $20,000, Minnesota) are confirmed,
but the hub designation sits only in the raw donor-name cell — there is no parsed
restriction attribute for "Apply decided" to flip. A prod check shows the Gates
allocation carries the Colorado region but its regional axis is still unrestricted,
and the Sauer allocation has neither the region nor the restriction. After "Apply
decided", set both allocations' regional axis to donor-restricted (and add Minnesota
to the Sauer allocation) by hand in the app, per rule 3. The rules still bind the
rows left donor-only (e.g. fy24_36 NBCDI-for-BWF, fy25_103 MN gen-op): when a human
confirms them later, apply the matching restriction even if the form says
unrestricted.

## Other judgment calls to sanity-check

- **Outside rules 1–4, "not restricted" answers do NOT latch donor-restricted.**
  Negation answers ("no", "unrestricted", "not restricted but…", "gen op") on
  non-BWF, non-hub rows still apply nothing to the usage axis, e.g. fy24_16 "no -
  designated but not restricted", fy24_40 "No - gen op support", fy25_43
  "unrestricted to Wildflower", fy25_7 "Not restricted but… Seed fund".
- **"Yes to BWF"-style answers DO latch donor-restricted** (the submitter answered yes to
  the restriction question), incl. "only to BWF, not by purpose".
- **Addresses:** applied only when the CRM had none (99 rows across both passes); conflicting addresses were left alone.
- **Regional restriction:** now applied on 70 rows (2 original + 54 under rule 3 + 14 second-pass confirms).
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

## 2. Donor pre-filled, left pending (6) — gift not booked yet

These stay in the queue: the money isn't in the CRM as a gift yet. The donor is stamped
so a later reviewer only has to attach the gift. (The other 12 rows that sat here in the
first pass moved to the second-pass confirms in section 4 — their gifts turned out to be
booked.)

| Row | Sheet says | Donor stamped | Note |
|---|---|---|---|
| FY24 row 30 | LISC $8,578.61 | Early Milestones (CO LISC) | LISC/Colorado funder; no $8,578.61 gift booked yet |
| FY24 row 36 | NBCDI $540.00 | National Black Child Development Institute | NBCDI = National Black Child Development Institute; no $540 gift booked yet |
| FY25 row 103 | Frey Foundation (via St. Paul + Minnesota Foundation) $60,000.00 | Frey Foundation | clean org match; no $60,000 gift booked yet |
| FY26 row 58 | Fidelity Foundations (prefers to be Anonymous in public facing documents) $15,000.00 | Fidelity Foundations | $15,000 slice of the $80,000 Inkwell grant; no matching gift booked yet |
| FY26 row 59 | Fidelity Foundations (They prefer to remain Anonymous in public facing documents) $65,000.00 | Fidelity Foundations | $65,000 slice of the $80,000 Inkwell grant; no matching gift booked yet |
| FY26 row 6 | Loyola University Maryland's Center for Montessori Education $2,088.00 | Loyola University Maryland | Center for Montessori Education sits under Loyola University Maryland; no $2,088 gift booked yet |


## 3. Skipped in the first pass (25)

(The two IRS ERC refund rows first judged as skips moved to section 5 — they are real
expected money (Employee Retention Credit refunds), donor = US Dept of the Treasury.)

| Row | Sheet says | Reason |
|---|---|---|
| FY24 row 49 | WeWork — | WeWork service-retainer refund — not a donation |
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

## 4. SECOND PASS — hand-matched confirms (49)

Each row was matched by hand against the booked gift in prod (donor cross-checked against
the gift's donor in every case — zero mismatches). Decisions follow the same owner policy
rules as the first pass. The three Kinsman/Clark duplicate pairs (FY25 rows 26/27/49 vs
GIRASOL rows 2/3/5) intentionally confirm the same gifts — each pair is the same money
appearing on two sheets.

| Row | Sheet says | Donor | Gift | Decisions | Why |
|---|---|---|---|---|---|
| FY25 row 45 | Sinha Kikeri Fund at Vanguard Charitable $500.00 | Sinha Kikeri Fund | FY25 Meera Sinha $500 to BWF (`rec1NB1EFS7dppJxA`) | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo | Sinha Kikeri Fund org; Meera Sinha (rec6Hdt6FCL1eoq8V) is the associated person |
| FY24 row 38 | Scholler Foundation $5,000.00 | Scholler Foundation (of Philadelphia) | FY24 Scholler $5,000 Grant (`recMHxIilqMtmedlw`) | apply: purposeVerbatim, usageRestriction, intendedUsage, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo | Scholler Foundation FY24 $5,000 grant, 2023-11-15 |
| FY26 row 61 | The Scholler Foundation (paid by The Glenmede Trust) $5,000.00 | Scholler Foundation (of Philadelphia) | FY26 $5,000 Scholler Donation (`recYz1N2w7yA2Rj8s`) | apply: purposeVerbatim, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: usageRestriction | Scholler FY26 $5,000, 2026-01-05 |
| FY24 row 39 | Spring Point $5,000.00 | Spring Point Partners | Spring Point $5,000 for MidAtlantic Conference Travel (`recbtJ7T6UEpUmrQE`) | apply: purposeVerbatim, usageRestriction, regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address | Spring Point $5,000 MidAtlantic conference travel |
| FY25 row 34 | Lars + Becky Klevan via Schwab Charitable $250.00 | Lars and Becky Klevan | $250 Schwab DAF Klevan FY25 (`recWAZ502r2py0y79`) | apply: intendedUsage, address, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction | Klevan Schwab DAF $250 FY25, 2024-11-22 |
| FY26 row 21 | Lars and Becky Klevan / DAFGiving360 $500.00 | Lars and Becky Klevan | FY26 $500 Klevan DAFGIving 360 (`recuWeRNpweITpTmV`) | apply: intendedUsage, address, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction | Klevan DAFGiving360 $500 FY26, same-day |
| FY26 row 25 | Cisco via Benevity $10,000.00 | Cisco / Cisco Foundation | FY26 Cisco Matching Gift/Benevity $10,000 (`rectfTJHD1Ct2Bff6`) | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo | Cisco/Benevity matching gift; booked $9,745 net of Benevity fee vs $10,000 sheet |
| FY26 row 99 | Gary Community Ventures $500.00 | Gary Community Investments | $500 Gary Community gift FY26 (`recSZlM6PB2MpEjpb`) | apply: intendedUsage, regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address | Gary Community $500 FY26, 2026-04-03 |
| FY26 row 19 | Allen + Carolina Vasan $5,000.00 | Allen Vasan | Allen Vasan FY26 $5,000 gift (`recfizeCcgJDLcstI`) | apply: circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address | Allen Vasan FY26 $5,000, 2025-10-28 |
| FY26 row 66 | Tosha Downey / DAFGiving360 $500.00 | Tosha Downey | FY26 $500 Downey to BWF (`recscOXQlnqcFapGh`) | apply: purposeVerbatim, usageRestriction, intendedUsage, circle, seriesType, additionalNotes, internalMemo · skip: address | Tosha Downey $500 via AOGF DAF (AOGF org is the intermediary, person is donor) |
| FY26 row 94 | Angie Schiavoni $261.28 | Sep Kamvar and Angie Schiavoni | FY26 Schiavoni $250 to support MN (`recJD01osCFlp9JBK`) | apply: regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction | Schiavoni $261.28 (sheet matches booked amount exactly), 2026-02-17 |
| FY26 row 60 | Diana Barrientos / Barrientos Family $10,000.00 | Abinadi and Diana Barrientos | FY26 Barrientos $10,000 to Girasol (`recKJm17gyYk0ElbE`) | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo | Barrientos FY26 $10,000 to Girasol; gift on household (row prefill was person) |
| FY24 row 21 | Hub: Colorado — | Gates Family Foundation | FY23/24 $95,000 (`reclJw7j6j0cv1AZW`) | apply: circle, seriesType, additionalNotes · skip: address | "Hub: Colorado / $95,000" = Gates Family Foundation FY23/24 $95,000 gift |
| FY25 row 72 | Erica Cantoni $1,041.00 | Erica Cantoni | FY25 $1000 to BWF (`reclHgE9b3eAiV4yB`) | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo | Erica Cantoni $1,041.44 booked 2024-12-13 (sheet $1,041, sheet date is entry date) |
| FY25 row 74 | Zita Blankenship $200.00 | Zita Blankenship | Zita FY25 $200 to BWF (`rec0CStLdZIdrKaUq`) | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address | Zita FY25 $200 to BWF, 2024-11-13; donor from gift |
| FY25 row 78 | Alia Peera $26.00 | Alia Peera | Peera FY25 $26.34 to BWF (`rec8WGeEsMTXIzkui`) | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo | Alia Peera $26.34 to BWF, 2024-11-20 |
| FY25 row 83 | Jasmine Williams $30.00 | Jasmine Williams | $30 FY25 Williams to BWF (`recDVrhuBjwrQn2tp`) | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo | Jasmine Williams $30 FY25 to BWF |
| FY25 row 99 | Mike Esposito $5.00 | Mike Esposito | $5 FY25 Esposito to BWF (`rec4RAqfCFyKbpOPd`) | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo | Esposito $5 FY25 to BWF |
| FY26 row 50 | Yohance Fuller $1,000.00 | Yohance Fuller | Fuller 1000.0 2025-12-17T18:00:36.871Z (`rec2rmfIruZyp45QG`) | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address | Yohance Fuller $1,000 donation booked $1,025.52 gross (donor covered fees) |
| FY26 row 67 | Keith Tom / Daffy Charitable Fund $50,000.00 | Keith Tom | FY26 $50,000 Tom grant to SSJ tech project (`recIFKQo27eY4UAss`) | apply: circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address | Keith Tom FY26 $50,000 (gift was prefilled by matcher; date on gift is 2024-12-03) |
| FY25 row 39 | Amy Gips / Fidelity Charitable DAF $5,000.00 | Amy Gips | $5000 FY25 BWF Sponsorship (`recSzMEOcixiUIJCc`) | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address | Amy Gips $5,000 FY25 BWF sponsorship, exact date match 2024-12-03 |
| FY25 row 61 | Coulter Financial Services, LLC $52.37 | Cristina Coulter | $52 FY25 Coulter to BWF (`recv2jzkZwsWyswq5`) | apply: purposeVerbatim, usageRestriction, address, circle, seriesType, additionalNotes, internalMemo | $52.37 FY25 Coulter to BWF booked on person Cristina Coulter (row FK was Coulter Financial org) |
| FY26 row 70 | Jacqui Miller $104.70 | Jacqueline Miller | MILLER 104.7 2026-01-01T04:51:37.240Z (`recD9JriPj0KXnfs9`) | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address | Jacqueline Miller $104.70 booked 2025-12-31; sheet dated 2026-02-23 (entry lag) |
| FY26 row 91 | James Cantoni $104.70 | Jim and Gretchen Cantoni | FY26 Jim Cantoni $104 to WF MN (`recWGpAhncOLyoCZ2`) | apply: regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction | Jim Cantoni $104.70 to WF MN booked 2026-02-12 |
| FY24 row 22 | Hub: Minnesota — | Sauer Family Foundation | Sauer FY24 Renewal (`copper-26819504`) | apply: circle, seriesType, additionalNotes · skip: purposeVerbatim, usageRestriction, address | "Hub: Minnesota / $20,000" = Sauer Family Foundation FY24 renewal $20,000, 2023-06-28 (inferred: only $20k MN-donor gift in window) |
| FY26 row 82 | Inspired Minds Collide $514.41 | Erika McDowell | McDowell 514.41 2026-02-06T21:17:17.771Z (`rechzl3wVUGWvokGY`) | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address | Inspired Minds Collide $514.41 booked on Erika McDowell person (her org); same exact amount |
| FY26 row 7 | Erica Cantoni $25.00 | Erica Cantoni | Erica Cantoni (`3Sma2jl733kNY_PeaKufu`) | apply: intendedUsage, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction | Erica Cantoni $25 + covered fees = $26.41 gross, same-day 2025-08-13 |
| FY26 row 9 | Matt Kramer $50.00 | Matthew Kramer | Matthew Kramer (`q8hdNMW-tU3mocujuvEvs`) | apply: intendedUsage, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address | Kramer $50 2025-08-13; gift on "Matthew Kramer" person (row prefill "Matt Kramer" recfaGqFyVmmQEt9Q is a duplicate person record — dedup candidate) |
| FY26 row 100 | Alexander Brown $150.00 | Alexander Brown | Alexander Brown (`CQCTOUS6l-g85uTYdidxx`) | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address | Alexander Brown $150 monthly, April instance 2026-04-10 |
| FY26 row 104 | Alexander Brown $150.00 | Alexander Brown | Alexander Brown (`O19isipf8UIhokCX94iCu`) | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address | Brown May instance; NOTE two May $150 gifts exist (eUBk8zWoVto1XYBEqosYN 05-08 and O19isipf 05-12) — possible duplicate booking to review |
| FY25 row 26 | Robert Kinsman $5,000.00 | Robert Kinsman | FY25 #1 $5000 to Girasol School (`recaEvDq6sH0dUwwD`) | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: intendedUsage | Kinsman gift #1 |
| GIRASOL row 2 | Robert Kinsman $5,000.00 | Robert Kinsman | FY25 #1 $5000 to Girasol School (`recaEvDq6sH0dUwwD`) | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, internalMemo · skip: intendedUsage | duplicate of fy25_26 (girasol sheet) |
| FY25 row 27 | Robert Kinsman- Kinsman & Krause Law Firm $5,000.00 | Robert Kinsman | FY25 #2 $5000 to Girasol School (`recIjd13EwIbt4srb`) | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: intendedUsage | Kinsman gift #2 (sheet row named the law firm; gift booked on person) |
| GIRASOL row 3 | Robert Kinsman- Kinsman & Krause Law Firm $5,000.00 | Robert Kinsman | FY25 #2 $5000 to Girasol School (`recIjd13EwIbt4srb`) | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, internalMemo · skip: intendedUsage | duplicate of fy25_27 (girasol sheet) |
| FY25 row 49 | Tom and Sarah Clark ℅ Timber Capital LLC $10,000.00 | Timber Capital LLC | $10,000 FY25 Timber Capital / Clark gift to Girasol (`recapgGLcI8ABN0R7`) | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: intendedUsage | Timber Capital/Clark $10,000 to Girasol, 2025-01-09 |
| GIRASOL row 5 | Tom and Sarah Clark ℅ Timber Capital LLC $10,000.00 | Timber Capital LLC | $10,000 FY25 Timber Capital / Clark gift to Girasol (`recapgGLcI8ABN0R7`) | apply: purposeVerbatim, usageRestriction, regionalRestriction, address, circle, internalMemo · skip: intendedUsage | duplicate of fy25_49 (girasol sheet) |
| FY25 row 0 | Arthur Rock $1,500,000.00 | Arthur Rock & Company | Arthur School FY24 (`recPuB4akP0d4AZsN`) | apply: circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, intendedUsage, address | Arthur Rock $1.5M "Arthur School FY24" gift 2024-06-25 (2 allocations: gen-ops + seed fund per memo) |
| FY25 row 109 | Arthur Rock $1,000,000.00 | Arthur Rock & Company | FY25 Arthur Rock - National (`rec9jTzxSntRLSX5K`) | apply: circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address | Rock FY25 $1.5M gift covers this $1M National row + fy25_110 $500k Seed row (2 allocations) |
| FY25 row 110 | Arthur Rock $500,000.00 | Arthur Rock & Company | FY25 Arthur Rock - National (`rec9jTzxSntRLSX5K`) | apply: circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address | second row of the $1.5M FY25 Rock gift (see fy25_109) |
| FY26 row 107 | Arthur Rock $1,150,000.00 | Arthur Rock & Company | Vanguard Charitable/Arthur Rock Fund (`DWN2URcC3_p0WhfUItlxo`) | apply: circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, intendedUsage, address | FY26 Rock $1.6M gift = $1.15M gen-ops + $150k BWF + $300k Seed; 3 allocations mirror rows 107/108/109 |
| FY26 row 108 | Arthur Rock (via Vanguard Charitable) $150,000.00 | Arthur Rock & Company | Vanguard Charitable/Arthur Rock Fund (`DWN2URcC3_p0WhfUItlxo`) | apply: circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, intendedUsage, address | BWF $150k row of the FY26 Rock $1.6M gift |
| FY26 row 109 | Arthur Rock $300,000.00 | Arthur Rock & Company | Vanguard Charitable/Arthur Rock Fund (`DWN2URcC3_p0WhfUItlxo`) | apply: circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, intendedUsage, address | Seed Fund $300k row of the FY26 Rock $1.6M gift |
| FY26 row 14 | The Bainum Family Foundation $100,000.00 | Bainum Family Foundation | FY26 Bainum (`recPAyPfDYjmRPFMY`) | apply: reportDeadline, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address | FY26 Bainum $200k booked as one gift with WF + BWF allocations; this is the BWF $100k row |
| FY26 row 15 | The Bainum Family Foundation $100,000.00 | Bainum Family Foundation | FY26 Bainum (`recPAyPfDYjmRPFMY`) | apply: reportDeadline, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, intendedUsage, address | Foundation General $100k row of the FY26 Bainum $200k gift |
| FY25 row 12 | Bainum Family Foundation $150,000.00 | Bainum Family Foundation | FY25 Bainum Grant - BWF #1 $75,000 (`rec6M9ehJDbPxExkc`) | apply: reportDeadline, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address | FY25 Bainum $150k paid as two $75k gifts; linked #1 (has the WF+BWF split allocations); #2 = rech41XoGnOj5mFf1 |
| FY25 row 40 | Spencer Burns $10,000.00 | Spencer Burns | FY25 $5,000 Burns to PR #1 (`rec45R65X7FeIZ9rs`) | apply: purposeVerbatim, regionalRestriction, address, circle, seriesType, additionalNotes, internalMemo · skip: usageRestriction, intendedUsage | Spencer Burns $10k booked as two $5k gifts (PR #1 + #2); linked #1; #2 = recjnNxL16EtgjwFM |
| FY25 row 64 | American Online Giving Foundation $3,500.00 | Gates Foundation | FY25 $2625 Gates matching grant for Tosha Downey (`recYeA9b5NLTUTWUE`) | apply: purposeVerbatim, usageRestriction, circle, seriesType, additionalNotes, internalMemo · skip: address | AOGF $3,500 check funded two gifts: Gates matching $2,625 (linked) + Downey $875 (recGpltnPNwQQXuQ3); AOGF is the DAF intermediary |
| FY24 row 33 | McKnight Foundation (Dana Anderson) $25,000.00 | McKnight Foundation | FY24 $25,000 McKnight - board designated (`recReHXt8wdJxqRwL`) | apply: intendedUsage, regionalRestriction, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction, address | McKnight $25k board-designated paid as two $12.5k gifts; linked #1 (2023-09-08); #2 = recrmfdpKoADPXlWx (2023-11-06) |
| FY25 row 108 | Stand Together Trust $500,000.00 | Stand Together | Stand Together FY26 $500,000 (`recPcj9oTgckhzPTp`) | apply: reportDeadline, address, circle, seriesType, additionalNotes, internalMemo · skip: purposeVerbatim, usageRestriction | Stand Together final $500k of 3; they paid $1M covering FY25+FY26 — this row maps to the FY26 $500k gift |

## 5. SECOND PASS — donor stamped, stays pending (7)

The two IRS rows move from "skip" to donor-stamped: Employee Retention Credit refunds are
real expected money, booked to the US Department of the Treasury when they arrive.

| Row | Sheet says | Donor | Note |
|---|---|---|---|
| FY24 row 26 | IRS Credit $4,133.58 | U.S. Department of the Treasury | stamped by the SQL (section 7) — IRS ERC refund — no gift booked anywhere (searched names, Treasury org, opportunities); Treasury org set as donor for when it lands |
| FY25 row 1 | IRS Credit $4,133.58 | U.S. Department of the Treasury | stamped by the SQL (section 7) — IRS ERC refund (FY25 letter) — same as fy24_26, not yet booked |
| FY24 row 20 | Gates Family Foundation $25,000.00 | already prefilled by the matcher (verified) | no write — Gates Family Foundation $25k 2024-05-15 — no booked gift at that amount (only the FY23/24 $95k exists) |
| FY26 row 31 | Jennifer Houghton — | already prefilled by the matcher (verified) | no write — Houghton — sheet has no amount; nothing to match |
| FY26 row 87 | Lizzette Sauque $5,000.00 | already prefilled by the matcher (verified) | no write — Sauque $5,000 2026-03-11 — no booked gift found in window |
| FY26 row 18 | Excellent Schools New Mexico $1,292.57 | already prefilled by the matcher (verified) | no write — Excellent Schools NM $1,292.57 stand-alone reimbursement — no booked gift yet |
| FY25 row 73 | Anonymous Donor $100.00 | already prefilled by the matcher (verified) | no write — Anonymous $100 — prefilled person is a catch-all anonymous record; no clean $100 FY25 gift on it |

## 6. SECOND PASS — skipped (7)

Prod was checked for staged QuickBooks rows matching each of these: every one is already
excluded in the reconciliation queue (earned_income / membership / zero_amount), so no new
staged-payment exclusions are needed.

| Row | Sheet says | Reason |
|---|---|---|
| FY25 row 60 | Vladimir and Chia Rodeski $5,000.00 | duplicate of girasol_11 (Rodeski booked $7,000, already confirmed there); fy25 sheet recorded a stale $5,000 |
| FY24 row 12 | DC Wildflower Public Charter School (DCWFPCS) $3,182.00 | DCWFPCS $3,182 — payment for Maia's time, not a donation (duplicate of fy25_2) |
| FY25 row 2 | DC Wildflower Public Charter School (DCWFPCS) $3,182.00 | DCWFPCS $3,182 — payment for services, not a donation |
| FY26 row 11 | DC Wildflower Public Charter School $24,965.00 | DCWFPCS $24,965 — reimbursement + services, not a donation |
| FY25 row 29 | ACUDEN $15,000.00 | ACUDEN — service revenue, not a donation |
| FY25 row 30 | ACUDEN $3,500.00 | ACUDEN — service revenue, not a donation |
| FY25 row 6 | Dr. Erika McDowell (not a donation) $141.68 | Dr. Erika McDowell $141.68 — sheet itself says not a donation |

## 7. SECOND PASS — left pending for a human (6)

| Row | Sheet says | Why it needs you |
|---|---|---|
| FY26 row 10 | Anonymous $20,071.51 | Anonymous $20,071.51 Seed Fund 2025-09-05 — no gift at this amount anywhere; donor unknown |
| FY26 row 8 | Matt Kramer $3.00 | Kramer $3 2025-08-13 — TWO identical $3 gifts exist same person/date (GtYi4sQJUKO4_YWcm0w8X, NONk3IQcw79-QdMJPmiNz): likely duplicate booking, resolve which to keep first |
| FY25 row 70 | Erica Cantoni $6.00 | Erica Cantoni $6 recurring — two $5.52 gifts (2024-11-04) for three $6 sheet rows; net/gross and count ambiguity |
| FY25 row 71 | Erica Cantoni $6.00 | same ambiguity as fy25_70 |
| FY25 row 75 | Erica Cantoni $6.00 | same ambiguity as fy25_70 |
| FY26 row 28 | Erica Cantoni $20.00 | Erica Cantoni $20 2025-12-02 — nearest gift $17.80 2025-11-17; not confident |


## 8. Confirmed matcher suggestions (161)

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

