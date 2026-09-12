---
status: current-status
last_verified: 2026-09-12
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
- Finance → Cash flow displays the timing basis for every row:
  projected close date, explicit payment date, timing not estimated, or annual
  reimbursement plan. Undated records remain visible here; no missing-date
  review items or tasks are generated. Existing annual forecasts are unchanged.
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

The default receipt window is the report's current Chicago calendar month plus
11 months, including empty months. The server's `asOfDate` anchors this window;
it does not depend on the viewer's device date or timezone. Each populated month
expands to show its underlying expectations, timing sources, and record links.

Earlier outstanding dates, dates beyond the next 12 months, undated balances,
and annual reimbursement context appear in separate collapsed groups. Earlier
amounts retain their original dates and are not moved into the current window.
Annual plans never enter receipt totals.

Funding-status and timing-basis filters apply together to every group, its
details, and its displayed totals. The browser only sums the server-provided
remaining amounts and weighted amounts for the visible selection; it does not
rederive probability, payment coverage, writeoffs, or dates. Unknown amounts and
probabilities remain visible and mark incomplete totals. No filter writes data
or creates cleanup tasks.
