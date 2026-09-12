---
name: Unified goal forecasting
description: The durable ownership and precision rules for fundraising goal forecasts.
---

All fundraising goal views—including Dashboard, FY Report, Projections combined
totals, and recipient comparisons—must use the single shared server-side forecast
read model. Do not reconstruct totals in a browser or reimplement contribution,
scope, payment-netting, archive, reimbursement, or diagnostic rules in individual
routes.

**Why:** Aggregating recipient-level unpaid balances can disagree with the
combined opportunity-level payment cap, and independently rounded display
components can disagree with the total. Parallel SQL also previously lost
allocation-level attribution for open opportunities.

**How to apply:** Keep open opportunities allocation-grain so each recipient,
purpose, and project remains accurate. Apply payment netting at opportunity
scope only where required for pledge commitments. Carry decimals through
aggregation and format only the final displayed values. Treat Projections
recipient cells as scoped comparisons, not values that may be summed into the
combined forecast. Keep explicit unknown recipient/year buckets separate from
combined values; matrix axes include applicable received, pledge, and goal data
plus current and next fiscal years.