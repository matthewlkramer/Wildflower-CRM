---
status: current-status
last_verified: 2026-09-21
---

# Funding arrivals by month

`GET /api/funding-arrivals-by-month` is the read-only timing view for funding
that is expected to arrive. It is authenticated and accepts the `category`
track (`revenue` or `loan_capital`) and an optional comma-separated or repeated
`entityId` scope.

## Definitions

- An active, unarchived, non-writeoff `status=pledge` record is **committed**.
  An active, unarchived, non-writeoff `status=open` record is **prospective**.
  Prospective results expose both face amount and
  `prospectiveWeightedAmount` (face multiplied by `win_probability`).
- Payment dates are optional. Per the owner's September 12 instruction, a
  standard one-time pipeline gift defaults to its effective projected close
  date, including a rolling months-out estimate. This means an open grant-track
  record using the fixed model whose commitment path is blank or `gift`.
  An explicit payment plan overrides the close-date estimate completely.
  Actual pledges, pledge-path prospects, loans, and reimbursement awards do not
  inherit that default. Allocation fiscal years never become receipt dates.
- The endpoint still exposes the timing basis for each receipt expectation:
  projected close date, explicit payment date, timing not estimated, or annual
  reimbursement plan. Undated records remain visible in the opportunity-grain
  `rows` response; no missing-date review items or tasks are generated.
- Known dated installment amounts produce `YYYY-MM` rows. A parent gift's
  non-archived amount is consumed once across its opportunity's schedule,
  oldest expected date first. This is a planning convention, not evidence that
  a payment matched a particular installment. The schedule has no recipient
  attribution.
- An installment with a null amount is unknown, not zero. Unknown earlier
  amounts can make later payment coverage uncertain; those amounts remain
  unknown rather than consuming payments speculatively. The report explains
  schedule discrepancies in its Notes column. Undated residual balances are
  separate from dated totals, so they cannot be added twice.
- Remaining schedules are capped at the collectible plan less recorded gifts
  and active writeoffs, using the canonical pledge-capacity formula. For open
  fixed opportunities the ask amount is used when recorded, otherwise the
  complete allocation plan. Pledge and reimbursement collection plans remain
  allocation-based. Unknown amounts are not inferred from an award ceiling.
- Compare the full schedule with the collectible plan before payments when
  identifying a discrepancy. A normal partial payment is not a discrepancy.
- A committed fixed-payment row is `overdue` only when its date is before the current Chicago
  calendar date and its oldest-first remaining balance is positive. This date
  comparison is date-only, so partial and complete payments cannot create a
  false overdue installment.
- Lost, dormant, cash-in, archived, and writeoff child records are excluded.
  Active negative writeoff allocations reduce the original balance; only a
  fully covered balance disappears. Archived writeoffs do not reduce it.
- `loan_or_grant=loan` is `loan_capital`; all other values are `revenue`.

## Recipient scope

The recipient filter is an inclusion test on pledge allocations. If any
non-direct allocation overlaps the requested scope, the parent schedule is
included exactly once. The installment is never split, prorated, or attributed
to an individual recipient, so rows from multiple recipient comparisons must
not be summed.

## Reimbursements

An award ceiling is not a forecast. Cost-reimbursement records contribute only
explicit known dated expected-payment rows and do not produce routine overdue
nags. Non-direct annual allocation plans remain informational report rows even
when only part of an award has explicit drawdown dates. These are gross plan
context, never additional remaining cash or monthly totals. Direct reimbursement
lines remain excluded. No historical amount or date is written or backfilled.

Target/scenario planning, concentration analysis, and follow-up workflow are
intentionally deferred. This endpoint is a timing read model only; it does not
add target, scenario, concentration, or follow-up semantics.

## Report navigation

The Finance navigation contains a dedicated **Cash flow** page at `/cash-flow`.
Projections remains the separate annual forecast at `/projections`.

Cash flow is an opportunity-grain spreadsheet with one row for every active
open opportunity and every pledge with an unpaid balance. Cash-in, dormant,
lost, archived, writeoff, and fully covered records are excluded. Each row
shows the ask amount, effective weighting (100% for pledges), three mutually
exclusive pairs of committed and weighted-target columns, the sum of those six
cells, and the earliest remaining forecast cash-flow date.

The allocation pairs use this precedence so a line is never counted twice:

1. Seed Fund — `fundable_project_id = seed_fund`.
2. Region-restricted — `regional_restriction_type = donor_restricted`.
3. Wildflower Foundation — every other allocation whose entity is
   `wildflower_foundation`.

Open allocations contribute only weighted targets (allocation amount times the
current win probability). Pledges contribute only committed amounts. Historical
payments are authoritative at the parent record, not reliably matched to every
plan line, so a pledge's canonical unpaid remainder is distributed
proportionally over its current allocation plan before the three reporting
buckets are summed. Allocations outside those buckets remain on the record but
do not enter the six displayed cells.

The forecast date is the earliest remaining dated payment-plan expectation. A
standard one-time prospect without a payment plan uses its effective projected
close date, including a rolling estimate. Undated records stay in the sheet
with a blank date. The browser only formats server-provided values; it does not
rederive weighting, payment coverage, writeoffs, bucket membership, totals, or
dates.

For compatibility and detailed scheduling logic, the response continues to
include the underlying `items` and monthly aggregates. They are not a second
Cash flow UI or a separate amount authority.
