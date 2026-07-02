---
name: Reimbursable direct/indirect share exclusion
description: How direct-tagged reimbursable allocation lines are excluded from goal analytics without touching derivation.
---

# Reimbursable direct/indirect share exclusion

Allocation lines (pledge + gift) carry a nullable `reimbursementType`
(`direct` | `indirect`) tag — **renamed from `reimbursableShare`** (pg type
`reimbursable_share` → `reimbursement_type`). Full
award/reimbursement amounts are always recorded; goal analytics EXCLUDE only
DIRECT-tagged lines. Untagged (null) and indirect both still count.

**Rule:** the exclusion predicate is `<col> IS DISTINCT FROM 'direct'`
(null-safe — null is NOT excluded). Centralized in analytics.ts as module consts
`pledgeAllocCountsTowardGoal` / `giftAllocCountsTowardGoal`, applied at every
goal-metric SQL site (fyMetricsFor pledged/paid/open/received,
fiscal-year-breakdown received/open, projections baseFilters).

**Why:** reimbursable grants reimburse direct program costs that aren't true
fundraising gains, so they'd inflate goal attainment if counted — but the org
still needs the full amount on record for accounting.

**How to apply / invariant:** the exclusion belongs ONLY to goal analytics.
Never let it leak into opportunity-status derivation or pledge paid-amount
derivation (`deriveOppFields`) — those must see the full amount regardless of
tag. Any NEW goal-metric query must add the same predicate or direct money
silently re-enters totals. UI prompt for splitting appears on opportunity detail
when `opp.conditional === "reimbursable"`; entry is manual only.
