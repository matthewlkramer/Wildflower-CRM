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
- Only `pledge_expected_payments` supplies payment timing. Projected close dates
  and allocation fiscal years are intentionally not timing guesses.
- Known dated installment amounts produce `YYYY-MM` rows. A parent gift's
  non-archived amount is consumed once across its opportunity's schedule,
  oldest expected date first. This is a planning convention, not evidence that
  a payment matched a particular installment. The schedule has no recipient
  attribution.
- An installment with a null amount is unknown, not zero. A fixed commitment
  with no schedule has a `missing_timing` action for its unpaid remainder.
  A dated null-amount row has a `missing_amount` action. Known schedule
  amount shortfall or excess compared with the unpaid remainder is reported as
  `schedule_discrepancy`; it is never silently assigned to a month.
- A dated row is `overdue` only when its date is before the current Chicago
  calendar date and its oldest-first remaining balance is positive. This date
  comparison is date-only, so partial and complete payments cannot create a
  false overdue installment.
- Lost, dormant, cash-in, archived, and writeoff records are excluded. An
  original with an active, unarchived writeoff child is also excluded as
  resolved; this intentionally aligns with canonical writeoff behavior.
- `loan_or_grant=loan` is `loan_capital`; all other values are `revenue`.

## Recipient scope

The recipient filter is an inclusion test on pledge allocations. If any
non-direct allocation overlaps the requested scope, the parent schedule is
included exactly once. The installment is never split, prorated, or attributed
to an individual recipient, so rows from multiple recipient comparisons must
not be summed.

## Reimbursements

An award ceiling is not a forecast. Cost-reimbursement records contribute only
explicit known dated expected-payment rows and do not produce missing-timing,
missing-amount, or overdue nags. When no schedule exists, non-direct annual
allocation plans are returned as informational
`untimedReimbursementPlans` with allocation and record IDs; they are never put
in monthly totals. Direct reimbursement lines remain excluded. No historical
amount or date is guessed.

Target/scenario planning, concentration analysis, and follow-up workflow are
intentionally deferred. This endpoint is a timing read model only; it does not
add target, scenario, concentration, or follow-up semantics.