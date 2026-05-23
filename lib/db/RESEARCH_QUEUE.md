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
