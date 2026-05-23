# Research queue

Open data-quality questions parked for later research. Each item has enough
context to resume cold. Resolve by either (a) correcting the data via a new
block in `post-import-fixups.sql`, or (b) updating the schema/semantics doc
in `SCHEMA.md` if the model itself needs to change.

---

## R1 — Vela Education Fund $300k gift (`recxDgoZ8xID1BapV`)

**Donor:** Vela Education Fund (funder) — single $300k standard_gift, received 2022-03-18.

**Issue:** `gift_allocations` for this gift has **26 rows summing to $331,500**
(+$31,500 over the actual cash received). All rows are
`intended_usage='school_startup'`, mostly FY22 (a couple FY21/FY25), each
exactly $7,000 or $18,500. None has a `school_recipient_id` or
`fundable_project_id` filled in.

**User context:** Vela handed WF a single check plus a list of schools and
per-school grant sizes; WF was responsible for distributing the funds.
So this is a true per-payment redistribution — the allocations should sum to
$300k exactly and (ideally) each row should name a recipient school.

**To research:**
- Pull the Vela distribution list (school → amount) from the original email /
  attachment.
- Reconcile against the 26 allocation rows: which rows are extras, which need
  school_recipient_id, which dollar amounts are wrong.
- Decide whether the FY21 + FY25 outliers belong on this gift at all.

---

## R2 — Stranahan Foundation pledge `Stranahan` (`rec8J1Lbc9jYMzG5d`) + payment `recwKC3JHKRY2QYHe`

**Donor:** Stranahan Foundation. Pledge awarded $600k; the $225k payment on
2020-11-16 (`recwKC3JHKRY2QYHe`) carries 9 `gift_allocations` summing to
**$250k** (one row is $0). Allocations span FY21 + FY22, both `gen_ops` and
`school_startup`.

**User context:** Stranahan gave WF a grant intending WF to award funds to
schools out of it. The allocations look like they describe the **entire $600k
pledge spread across the multi-year award**, not the $225k that arrived in
this single payment.

**To research / decide:**
- Confirm with finance whether the 9 allocations are meant to describe the
  pledge-level distribution plan (in which case they belong on
  `pledge_allocations` for the parent pledge, not on this single gift), or
  the actual per-payment split (in which case they need to be corrected so
  they sum to $225k).
- Possibly a broader schema decision: for "grants WF redistributes" do we
  model the per-school awards as `gift_allocations`, `pledge_allocations`, or
  a new redistribution table? Same question applies to Vela (R1) and the Nash
  $1M seed challenge.

---

## R3a — 4 won opps missing `actual_completion_date` (RESOLVED with 1 follow-up)

All 4 won opps that lacked `actual_completion_date` were backfilled from
`MAX(date_received)` of their gifts (see fixup #15 in
`post-import-fixups.sql`) so the new
`opportunities_and_pledges_won_requires_completion_date` CHECK constraint
could be added cleanly.

| opp id | funder | name | awarded | backfilled date | basis |
|---|---|---|---|---|---|
| `recEDlbIedGzGfGxq` | Imaginable Futures | Imaginable Futures FY24-26 BWF | $900,000 | 2024-10-30 | full $900K landed in 3 installments — last on this date |
| `recohEH4lZm5yixFm` | Spring Point Partners | SpringPoint PRI - Emerging Hub Revolving Loan Fund | $500,000 | 2019-09-04 | full $500K in one payment |
| `recshOnvUb0A390qj` | Bainum Family Foundation | FY26 Bainum Grant | $200,000 | 2025-09-17 | full $200K in one payment |
| `rec3MTMlSE06qaL2L` | Gates Family Foundation | Gates Family Foundation | $85,000 | 2020-02-07 | **only $40K of $85K landed** — see follow-up below |

**Follow-up — Gates Family Foundation `rec3MTMlSE06qaL2L` — RESOLVED 2026-05-23 (data state confirmed at source):**
Verified directly against live Airtable (`app8KUcmaHZ0AtcJZ`,
`tblWjfKjK0j6FbNCZ`). The opp stores `awarded_amount: 85000`,
`total_payments: 40000`, `outstanding_amount: 45000`, status `Won`,
stage `Written commitment - 100%`, `win_probability: 1`. So Airtable
itself records the $45K as outstanding on a fully-committed grant —
the importer mirrored that faithfully and there is no missing payment
record in the source. Whether the second payment is late, was waived,
or needs chasing is a fundraising-team / Gates relationship question,
not a CRM data bug. No DB action; flagged for fundraising team.

---

## R4 — 7 lost/dormant opps not found in Copper export

The Copper opps export (`attached_assets/opportunities_*.xlsx`) gave us
preliminary scope for 181 of the 188 lost+dormant opps that came in from
Airtable without `pledge_allocations` (backfilled in `post-import-fixups.sql`).
These 7 had no matching Copper row and remain without any allocation data:

| db opp id | status | funder | name | amt |
|---|---|---|---|---|
| `reckrY6qgOYBhZYks` | dormant | Morningside Group | Gerald Chan Grant | $1,000,000 |
| `recssTBtZ9k74zQCI` | dormant | Chan Zuckerberg Initiative | Observant Ed funding - early stage lead FY24 | $1,000,000 |
| `recHpvemLnwZ1WDFz` | dormant | Chan Zuckerberg Initiative | CZI--DEI Funding | $600,000 |
| `receBhBgkDR5VfYoP` | dormant | Chan Zuckerberg Initiative | CZI | $500,000 |
| `rec2E64MafoE8l4Wn` | dormant | Hastings Fund | Hastings Fund Grant | $250,000 |
| `recjTWxb1Ft7oSQhu` | dormant | Ecolab Foundation | Ecolab Foundation | $25,000 |
| `recScY6tRHfXmVRD2` | dormant | 3M Foundation | Jon Banovetz | $5,000 |

(Re-derive the IDs anytime with:
`SELECT o.id, o.status, f.name AS funder, o.name, o.ask_amount
 FROM opportunities_and_pledges o JOIN funders f ON f.id=o.funder_id
 WHERE o.status IN ('lost','dormant')
   AND NOT EXISTS (SELECT 1 FROM pledge_allocations WHERE pledge_or_opportunity_id=o.id);`)

**To research:** find the original solicitation notes (Airtable history, email
threads, or Copper directly if the records still exist by a different name)
and decide grant_year + region/intended_usage. The CZI rows in particular
look like they may post-date the Copper export (Observant Ed / DEI funding
are recent themes), so they may genuinely have no Copper provenance.

**Ambiguity notes (informational, no action needed):** during matching, two
funder/name pairs had multiple Copper candidates: `New Profit / New Profit`
(5 DB rows ↔ 4 Copper rows) and `Ciresi Walburn / Ciresi Walburn Foundation`
(2 ↔ 2). In both cases all Copper rows in the cluster shared identical scope
data (same grant_year, same hub), so picking any match yielded the same
allocation — no disambiguation needed.

---

## R5 — Primary contact backfill: unresolved cases

`post-import-fixups.sql` set `primary_contact=true` on the sole current PER for
**637 single-PER entities** (Phase 1: 72 funders + 524 orgs + 38 households + 3
payment intermediaries) and disambiguated **147 multi-PER entities** (Phase 2:
18 funders + 129 orgs) using Copper's "Primary Contact" column from
`attached_assets/companies_*.xlsx`. The cases below still need a human to pick.

### R5a — Multi-PER entities whose Copper company has no Primary Contact set (24 entities)

| type | name | # current PERs |
|---|---|---|
| funder | Reinvestment Fund | 6 |
| funder | 22 Beacon | 2 |
| funder | City of Ponce | 2 |
| funder | U.S. House Ways and Means Committee | 3 |
| funder | NYC Mayor's Office of Contract Services (MOCS) | 2 |
| funder | Bridgespan Group | 9 |
| funder | New York City Mayor's Office | 2 |
| funder | Meta | 2 |
| funder | Eastern Bank / Eastern Bank Foundation | 3 |
| funder | 1954 Project | 2 |
| funder | NewSchools | 11 |
| funder | Building Impact Partners | 3 |
| funder | Old National Bank / Foundation | 2 |
| org | Kohlberg Kravis & Roberts (KKR) | 2 |
| org | Manny Cantor Center | 2 |
| org | Durst Organization Inc | 2 |
| org | Pahara Institute | 3 |
| org | Murmuration | 2 |
| org | Dorsey LLP | 2 |
| org | Naz | 2 |
| org | Costanoa Ventures | 2 |
| org | Biden Administration | 2 |
| org | All our Kin | 3 |
| org | Instituto Nueva Escuala | 2 |

### R5b — Multi-PER entities where Copper's named Primary Contact isn't in our DB (25 entities)

For each row, pick one of the listed PER candidates as primary, or add the Copper-named
person to `people` first (many of these Copper primaries are senior leaders who were
likely never loaded).

| type | name | copper primary contact (name only) | DB candidates |
|---|---|---|---|
| funder | MA Department Of Elementary and Secondary Education | Cliff Chuang | Alison Bagg, Alyssa K. Hopkins, Christina Grant, Heather Peske, Marty West |
| funder | Pivotal Ventures | TBD Pivotal Ventures | Jennifer Stybel, Matt Parodi, Melinda French, John K. Sage |
| funder | Fidelity Foundations | Caroline Nolan | Angela Bacon, Emily O'Donnell, Alice Bennett, Barbara Sullivan, Emma Pengelly |
| funder | Transcend Education | Jeff Wetzler | Arielle Kinder, Aylon Samouha, Cynthia Robinson-Rivers, David Nitkin, Deborah Gist, Divya Mani, Jenee Henry, Jennifer Charlot, Molly Martineau |
| funder | Drexel Fund | John Eriksen | Naomi DeVeaux, Eric Oglesbee, Darren R. Jackson, Mark Gleason, Nick Howley |
| funder | Stranahan Foundation | Pam - DO NOT CONTACT Howell-Beach | Abby Stranahan, Bonnie O'Keefe, Patrick Stranahan, Sara Mead, Hillary Beuschel |
| funder | Louis Calder Foundation | Holly Nuechterlein | Barbara Atkeson, Alexander Calder |
| funder | Bezos Academy / Day 1 Academies Fund | Mike George | Caroline Hult, Michael Abello, Sabrina Watkins, Joel Mendes, Jeff Bezos, Miguel Roque, Will Nash |
| funder | Propel Nonprofits | Kate Barr | Andrea Snow, Andrea Sanow, L Hang |
| funder | Stupski Foundation | Joyce Stupski, Deceased | Jennifer Nguyen, Glen Galaich |
| funder | Schmidt Futures | Kumar Garg | Robyn Watkis, Eric Schmidt, Ulrich Boser |
| funder | Ballmer Group | Jeff Edmondson | Loren Harris, Raychael Jensen, Steve Ballmer, Terri Ludwig |
| funder | Frey Foundation | Carol Frey Wolfe | Jim Frey, Flor Treviño Frey |
| funder | Promise Venture Studio | Michael Dougherty | Buckley Bloom, Gabe Hakim, Matt Glickman, Melissa Field, Karen Lien, Demetra Brown |
| funder | Valhalla Foundation | Amy Rodde | Laura Brookhiser, Nancy Poon Lue, Sara Allan |
| funder | Commonwealth Of Massachusetts | Jim Peyser | Anita Moeller, Ola J. Friday, Stacey (CTF) Nee |
| funder | Teach For America | Paul Keys | Ben Lindy, Josh Bell, Fatimah Burnam Watkins, Erin Renz, Rhonda D. Ford, WaziHanska Cook, Holly Trifiro, Heather Tow-Yick, Vanessa Nicholson, Claiborne Taylor, Ronald Nurnberg, CJ Crowder, Sunanna Chand, Mary Koslig, Daniel Riley, Caitlin Wood Sklar, Lakeisha Wells-Palmer, Jemina Bernard, Hope Lesane, Tiffany Cuellar Needham, Whitney Petersmeyer, Molly Ellenberg Friedland, Ada Tadmor, Jennifer Early, Sondra Ranum, Michelle Culver, Tracy-Elizabeth Clay, Elijah Heckstall, Amy Jacobs, Heather Ryan, Charissa Fernandez |
| funder | one8 Foundation | Vanessa Lipschitz | Stephanie Loder, Joanna Jacobson, Crisandra Gray |
| org | Wildflower Foundation | Paul DeCoursey | Matthew Kramer, Juan Goytia, Brandon Royce-Diop, Maggie Paulin, Hannah Ewert-Krocker, Jenny Tak, Dominque Burgess, Kameeka Shirley, Maya Warsame, Cameron Leonard, Keith Waxelman, Christine Grodek, Li Ouyang, Jennifer Houghton, Erin Quigley, Isabelle Bibbler, Pooja Pandit |
| org | Stanford University | John Hennessy | Isabelle Hau, Philip Fisher |
| org | Powderhouse Studios | Alec Resnick | Molly Josephs, Shaunalynn Duffy |
| org | McKinsey & Company | Asheet Mehta | Kurt Strovink, Emmilie Berkner, Sarrah Weston, Deniz Cultu, Jake Bryant, Emily Cline, Kweilin Moore Ellingrud, Nancy Killefer |
| org | Denver's Early Childhood Council | Nicole Riehl | Dora Esparza MNM MAPY, Jill Rocha |
| org | American Montessori Society | Sara Wilson | Brittany Emilio, Carla Hofland, Cara Paige, Munir Shivji, Scott Davidson, Maria Meyerovitch, Luisana Kinaj |
| org | University of Minnesota | Eric Kaler | Christine Cheng, Matt Kramer, David Duxbury, Chad Ostlund |

### R5c — Multi-PER households missing primary (31 households)

No Copper-equivalent record carries a primary-contact hint for households. Team
should pick one spouse/partner as the canonical contact per joint account.

| household id | name | # current PERs |
|---|---|---|
| `recbVW1CwSP4v78bG` | Aaron Augusten and Kristen Tronsky | 2 |
| `recxjRp97W3KHFpNp` | Adam and Sylvia Spector | 2 |
| `recJ4eyPXrTKhHDj9` | Andrew & Bonnie Weiss | 2 |
| `recMkHxaaTaolTF6l` | Ann & Andy Mathieson | 2 |
| `rec5E2eXW8QMeZS38` | Arthur & Lindsay Reimers | 2 |
| `recCId8A3HdF6xlq2` | Arthur Rock & Toni Rembe Rock | 2 |
| `rec673AHumJJiIPSy` | Avi and Sandra Nash | 2 |
| `rec96vrK8fDmvfgwp` | Catherine and John Debs -- | 2 |
| `recxHxEnzPvVstIRp` | Chad and Eleanor Laurans | 2 |
| `recvPJlmXOysmDrsW` | Charlie and Rebecca Ledley | 2 |
| `rec9hw0umkRamBYKC` | Cynthia and Ben Guill | 2 |
| `recO0gGVztHFSGuWA` | Denniz and Margarita Cultu | 2 |
| `recrZKr5BGbiWzm6S` | Diana Nelson and John Atwater | 2 |
| `recqpZiFsFYheC8Ot` | Dustin Moskovitz and Cari Tuna | 2 |
| `recWXnuj302xEr4ic` | Janine and Jeff Yass | 2 |
| `recHQOSmTjs5AmsDF` | Jen Moses and Ron Beller | 2 |
| `recR3ZeWKkG28DUpW` | Katie and Nick Piehl | 2 |
| `recKYqy4Ex554BliC` | Lars and Becky Klevan | 2 |
| `recIvICY2Ohv9PHyo` | Manju and Bud Basu | 2 |
| `recaOqvRvJjGFyq66` | Mark and Jill Blank | 2 |
| `reclqsSU7dOnEmcuG` | Matt and Katie Kramer | 2 |
| `recdz3InaVKbqVhv5` | Matt and Lindsay Haldeman | 2 |
| `recRP8inTd32w6t0J` | Matthew and Hannah Granade | 2 |
| `recIJTPGCH2DtgplA` | Nancy Peretsman and Bob Scully | 2 |
| `recnMl6h76JEYbjQz` | Nick Nash and Phalgun Raju | 2 |
| `recx9Hb1wblVizln5` | Scott Berney and Sara Hennessey Berney | 2 |
| `recRCXN9REdI3Wg5c` | Sep Kamvar and Angie Schiavoni | 2 |
| `reccGUFMuwcb1GWkk` | Susan and Thomas Dunn | 2 |
| `reculUSRsNoFe2GPs` | TC & Joe Scornavacchi | 2 |
| `recLF6jNpB9Lgemp5` | Tim and Liz Welsh | 2 |
| `recP1ebGhDzgyCDd1` | Vladimir and Chia Rodeski | 2 |

### R5d — Multi-PER payment intermediaries missing primary (2 entities)

| id | name | # current PERs |
|---|---|---|
| `recJTl13VH5S3qn4x` | Fidelity Charitable | 2 |
| `recrmhNVw0DVQfuwZ` | Vanguard Charitable | 2 |

### R5e — Funders with MORE than one current primary contact (2 data error)

Pick one (set `primary_contact=false` on the other).

| funder id | name | # flagged primary |
|---|---|---|
| `recQT9iS65T6KfW6a` | George W. Brackenridge Foundation | 2 |
| `recRM4wcdvoEJ5yqG` | U.S. Bank / U.S. Bank Foundation | 2 |

---

## R6 — Same-name people pairs (RESOLVED)

Audit #13 flagged 6 pairs of `people` rows sharing a normalized full name.
Resolution (applied in `post-import-fixups.sql`):

| pair | conclusion | basis |
|---|---|---|
| Beth Anderson | different people | Hill Center NC vs MA Public Charter Assoc — distinct employers + cities |
| David McKnight | different people | `powerofzero.com` author vs NAM Manufacturing Institute VP |
| Josh Engel | different people | Border States branch manager (MN) vs EdSurge/ISTE Sr Director |
| Scott Burns | different people | Walton Family Foundation vs GovDelivery CEO (MN) |
| Dominque Burgess | **merged** | `reciB5Lfg6MgJb84q` → `rec5dkuXrNWQyDk5P` (Wildflower Foundation; personal email preserved) |
| Ted Quinn | **merged** | `recxOIfD5BCEYw7hi` → `rec5rOo1sEIAUBLd3` (Wildflower Foundation; personal email + NYC address preserved) |

No further action.

---

## R3 — Sep Kamvar & Angie Schiavoni $225,336 stock gift (`recPunRkZWh2pKVnr`) — RESOLVED 2026-05-23

**Donor:** Sep Kamvar and Angie Schiavoni (household). $225,336 stock gift,
received 2019-12-27. Not tied to a pledge.

**Original issue:** Two `gift_allocations` rows: $320,336 (FY20, no
intended_usage, Rising Tide) + $100,000 (FY20, `gen_ops`, Wildflower
Foundation) = **$420,336**, which is $195,000 over the recorded gift
amount.

**Resolution (from live Airtable `app8KUcmaHZ0AtcJZ`,
`tblr3ewPT3e6FWKPx`, record `recPunRkZWh2pKVnr`, `details` field — verbatim):**

> "Sep gave $195,000 in cash on 12/27 and gave 123 shares of Amazon
> stock on 12/30 which I liquidated the same day for $225,336. The
> stock gift came from the Scout and Jem Finch Charitable Trust. The
> grand total is ~$420k. The intended use for the gifts is for Rising
> Tide and New Jersey Hub work. But I think for official purposes we
> can consider it unrestricted $$$, which we'll then choose to use for
> these two hubs."

So there are really **two gifts** totaling ~$420,336:

- $195,000 cash on 2019-12-27 — **not recorded as its own
  `gifts_and_payments` row in Airtable**
- $225,336 stock on 2019-12-30 (liquidated same day; FMV-as-cash) —
  this is `recPunRkZWh2pKVnr`

Both allocations ($320,336 Rising Tide + $100,000 WF gen-ops =
$420,336) were sized for the combined total and both hang off the
single stock-gift record because there is no cash-gift sibling to
link the cash portion to. The arithmetic isn't broken; the source
system is missing the $195K cash gift record.

**Follow-up applied 2026-05-23 (fixup #19 in `post-import-fixups.sql`):**
On a second pass we found the $195K cash gift already existed in
both DB and Airtable as `recs30mG9xDAg81iz` — an orphan row with
only `amount=195000`, `payment_method=check`, and `individual_giver`
set (later moved to `household_id=recRCXN9REdI3Wg5c` by the
household-as-donor pass). Everything else was blank. Fixup #19:

- **19a** backfilled the cash gift's metadata: `name`,
  `date_received=2019-12-27`, `type=standard_gift`, `grant_year=fy2020`,
  `details` (with a pointer back to the stock sibling and this
  RESEARCH_QUEUE entry), `owner_user_id=usr_matthew_kramer`.
- **19b** backfilled the cash gift's empty allocation
  `synth-ga-recs30mG9xDAg81iz` with `entity_id=rising_tide` and
  `grant_year=fy2020` (sub_amount $195,000 was already correct).
- **19c** trimmed `rec0cwaXUyDulGagw` from $320,336 → $125,336 so
  the stock gift's allocations sum to its own amount ($125,336 +
  $100,000 = $225,336).

Per-gift balances after the fix:

| gift | amount | allocations | diff |
|---|---|---|---|
| `recs30mG9xDAg81iz` (cash, 12/27) | $195,000 | $195,000 Rising Tide FY20 | $0 |
| `recPunRkZWh2pKVnr` (stock, 12/30) | $225,336 | $125,336 Rising Tide + $100,000 WF gen_ops FY20 | $0 |

Combined entity totals unchanged: $320,336 Rising Tide + $100,000
WF gen_ops = $420,336 (matches donor intent in note). Fixup is
idempotent (COALESCE-guarded backfills + amount-guarded rebalance).

## R4 — Three nameless people remaining after fixup #16 — RESOLVED

After fixup #16 backfilled 7 of the 10 nameless `people` rows (Homer Allen,
Jingyi Kerry Wang, John Kirtley, Mark Medema, Mark Suster, Amanda
Schaumburg, Neil Gulyako), three rows remained with no recoverable
identity. None was referenced by any gift, opportunity, or PER; each
carried only a single orphan email.

**Resolution (per Wildflower direction 2026-05-23):** deleted in fixup
#17. The 3 emails cascade-deleted via the `emails.person_id ON DELETE
CASCADE` FK. The 3 dropped rows were:

  - `recL6FIc0OGEklzcU` (`nortiz19@gmail.com`)
  - `recLM2ZFmxtXI6sMZ` (`dr@elephantenergy.com`)
  - `recWxIpa4mpC5bn83` (`jmammadova@strategicpolicy.nyc.gov`)

### Follow-up — RESOLVED

Caprock Strategies and Upfront Ventures both added as `organizations`
in fixup #18 (`small_business_consulting` and `investor` respectively).
Amanda Schaumburg now has a `past` PER to Caprock alongside her
`current` one at Penn Hill; Mark Suster has a `current` PER to Upfront.
