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

## R3a — 4 won opps missing `actual_completion_date`

These opps are marked `status='won'` but have no completion date recorded.
Per SCHEMA.md, every won opp should carry the date the grant was finalized.
Look up the actual award/agreement dates from funder correspondence or
internal records and populate `actual_completion_date`.

| opp id | funder | name | awarded |
|---|---|---|---|
| `recEDlbIedGzGfGxq` | Imaginable Futures | Imaginable Futures FY24-26 BWF | $900,000 |
| `recohEH4lZm5yixFm` | Spring Point Partners | SpringPoint PRI - Emerging Hub Revolving Loan Fund | $500,000 |
| `recshOnvUb0A390qj` | Bainum Family Foundation | FY26 Bainum Grant | $200,000 |
| `rec3MTMlSE06qaL2L` | Gates Family Foundation | Gates Family Foundation | $85,000 |

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

## R3 — Sep Kamvar & Angie Schiavoni $225,336 stock gift (`recPunRkZWh2pKVnr`)

**Donor:** Sep Kamvar and Angie Schiavoni (household). $225,336 stock gift,
received 2019-12-27. Not tied to a pledge.

**Issue:** Two `gift_allocations` rows: $320,336 (FY20, no intended_usage)
+ $100,000 (FY20, `gen_ops`) = **$420,336**, which is $195,000 over the
actual gift amount. Suspicious arithmetic: $320,336 = $225,336 + $95,000.

**Hypotheses to test:**
- The $320,336 row conflates the stock FMV with a match/companion gift.
- The $100,000 row belongs on a different gift entirely (mis-linked
  `gift_id` in Airtable).
- One or both rows belong on a separate pledge.

**To research:**
- Cross-reference Copper opps export for Kamvar/Schiavoni gifts in late
  2019 / early 2020.
- Check Airtable history if reachable (base is archived but possibly
  still readable) for the original `gift_id` on these allocation rows.
