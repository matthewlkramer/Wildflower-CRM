---
name: Weighted projection dashboard tile
description: How the dashboard "Weighted projection" money tile is defined and the one overlap to watch.
---

# Weighted projection tile (dashboard money grid)

Per-FY tile sitting right after "Goal":

`weighted projection = received + committed + weighted open asks`

Component → data mapping (all entity-scoped at the allocation level, by `grant_year`):

- **received** = `SUM(gift_allocations.sub_amount)` — money actually in.
- **committed** = `SUM(pledge_allocations.sub_amount)` for opportunities with
  `status='pledge'` (written commitment, not yet fully paid).
- **weighted open asks** = `SUM(pledge_allocations.sub_amount × win_probability)`
  for opportunities with `status='open'`.

**Why this mapping:** opportunity `status` is fully derived (see `pledgeStage.ts`):
`cash_in` = fully paid, `pledge` = written_commitment & not fully paid, `open` =
still in the funnel. So `committed` (status=pledge) and `weighted open asks`
(status=open) are **disjoint by status** — they can never double-count each other.

**The one overlap to watch:** a partial payment booked against a `status='pledge'`
opp lands in **received**, while that opp's full pledge allocation lands in
**committed**. If both the commitment and the partial payment are allocated to the
*same* grant_year, the projection overstates by the paid portion. As of this build
that overlap is $0 in the dev data (no pledge-status opps have allocations in the
current/next FY), so it's latent, not active. If a future request needs a clean
"expected FY total", switch `committed` to the *unpaid remaining* balance instead
of the full pledge allocation.

**How to apply:** keep server exposing raw components (`received`, `committed`,
`openPipelineWeighted`, `openPipelineAsk`, `goal`) and let the client compose the
projection tile (mirrors the existing money-tile pattern). The tile is a composite
with no drilldown href (like Goal).
