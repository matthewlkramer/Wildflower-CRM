---
status: ratified
last_verified: 2026-07-23
---

# UI #2 — Deposit Workbench Actions

This is the ratified action target for the deposit-first workbench. It
complements [`workbench-business-rules.md`](workbench-business-rules.md) with
the per-column action boundary. Status labels are:

- **LIVE** — the backend action exists and is wired on the live deposit page.
- **WIRE** — the backend action exists but is not wired on the live deposit
  page, or needs a small surface/rollup change.
- **GAP** — new backend work is required.

## Grain and row alignment

The component/payment unit is the true reconciliation grain:

```text
Bank deposit
└── component/payment unit
    ├── 0 or 1 counted CRM gift/allocation
    └── 0..N documenting QBO records, derived through typed evidence ties
```

The live workbench remains four columns:
**Bank | Composition | Gifts | Accounting**. Columns 2–4 are row-aligned per
component; they are not independent deposit-level lists.

- Stripe charges are components through the payout; checks, ACH, wires, and
  other direct payments are components through `bank_deposit_components`.
- `payment_applications` tracks the only counted money→gift relationship:
  one component/payment unit to zero or one gift. If evidence appears to point
  to multiple gifts, merge the intended meaning into allocation rows on one
  gift; do not create parallel counted gift links.
- There is no tracked deposit→gift relationship.
- Excluded components remain visible in Composition with an **Excluded** badge.
  Exclusion removes them from active counting, but gross→net→bank
  reconciliation must remain inspectable.

## Column action target

### Bank

- **Mark not fundraising / return to open queue** — a convenience action that
  excludes or re-includes all components of a deposit. The authority is
  component-level; the deposit-level `bank_deposit_exclusions` implementation
  from PR #42 is being migrated down, and deposit `not_fundraising` is derived
  when all components are excluded. **LIVE today at deposit grain; target
  component grain.**
- **Link, unlink, relink, and confirm ambiguous payout pairing** — operate on
  `stripe_payouts.bank_deposit_id` and its ambiguity flag. **LIVE.**
- A payout with no expected bank deposit (balance withdrawal, net ≤ 0, or
  failed) is a **derived** state, not a routine manual bundle action. Keep only
  a rare manual escape hatch for a genuinely ambiguous remainder. **WIRE/GAP
  depending on the escape-hatch path.**

### Composition

- Exclude/re-include a charge or direct component while leaving the component
  visible and badged. Charge exclusion/re-inclusion is **LIVE**; direct
  component exclusion/re-inclusion is **GAP**.
- Confirm or dismiss provisional `deposit_qbo_components`. **LIVE.**
- Confirm or dismiss processed refund propagation. **LIVE.**
- Resolve an unresolved remainder in either of two ways:
  1. Add a placeholder component flagged `needs_research`. **GAP.**
  2. Add a known payment component. Search existing unclaimed check
     `payment_units` first (D4), create a fresh unit only if none matches, and
     optionally tie it to a QBO record or annotate why QBO is missing. **GAP.**

### Gifts

- On a component with no gift: search and link an existing gift, create a gift
  from evidence, or identify the donor without creating a gift. **LIVE** for
  existing staged-payment/Stripe flows.
- Donorbox donation search/link/create and donor coding-form lookup are
  available backend capabilities but are not surfaced in the live deposit
  page. **WIRE.**
- On a component with one gift: unlink/revert the component→gift booking.
  **LIVE** for the existing staged-payment/Stripe flows.
- Merge apparent duplicate gifts into allocation rows on one gift. **LIVE**
  for gift merge; this is the repair for apparent >1 gift per component.
- Multi-match N QBO rows to one gift remains supported as N unit-grain
  applications. **LIVE.**
- The old “Match evidence” pile-on is removed from this surface because it
  conflicts with the 0/1-gift-per-component rule.
- “Mark lost/dormant” is removed from this surface. Loss is an
  opportunity/pledge disposition; a gift exists only once payment is booked.

### Accounting / QBO

- QBO is downstream documentation, not the money or gift authority.
- Keep typed evidence tables:
  - `source_links.charge_qb_tie` for gross charge ties;
  - `source_links.charge_fee_row` for processor-fee rows;
  - `source_links.donorbox_qb` and `source_links.donorbox_charge`;
  - `deposit_qbo_components` for QBO deposit-member lines ↔ bank deposits.
- One charge/gift may therefore document against multiple QBO records (gross
  plus fee), and a QBO deposit may document multiple components.
- Gift/allocation ↔ QBO is derived transitively through the component's ties.
  Do not add a direct gift↔QBO link or a general M:N documentation table.
- Column 4 shows 0..N documenting QBO records per aligned component. The
  derived per-node rollup is **GAP**.
- “Search QB & pull backward” from a Composition/Gift component writes the
  appropriate typed tie. QB search is **WIRE**; the attach path is **GAP**.
- Reject charge ties, revert confirmed ties, confirm proposed matches, and
  confirm payout charge ties are existing but not wired to the live deposit
  page. **WIRE.**
- Accounting-check dispositions (`consistent`, `corrected`,
  `accepted_historical`, and `correction_needed`) need a write endpoint.
  **GAP.**
- Exclude at the component, never at the derived QB card. **GAP/WIRE** until
  component-grain exclusion exists.

## Explicit backend gaps

1. Component-grain exclusion and derived all-components deposit disposition.
2. Placeholder-component creation with research flag.
3. Known-component creation with unclaimed-check-unit search-first behavior.
4. Direct component exclusion/re-inclusion.
5. Per-component QBO rollup and backward typed-tie attach.
6. Accounting-check disposition mutation.

The endpoint inventory in
`../.agents/scratch/ui2-endpoint-inventory.md` records the currently available
routes and generated hooks; scratch files are not committed documentation.
