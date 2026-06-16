---
name: Weighted projection dashboard tile
description: How the dashboard "Weighted projection" money tile is defined and the one overlap to watch.
---

# Weighted projection tile (dashboard money grid)

Per-FY tile sitting right after "Goal":

`weighted projection = received + committed + weighted open asks`

Component → data mapping (all entity-scoped at the allocation level, by `grant_year`):

- **received** = `SUM(gift_allocations.sub_amount)` — money actually in.
- **committed** = the UNPAID remainder of `status='pledge'` commitments for the
  FY: per opp, `GREATEST(SUM(pledge_allocations.sub_amount) − payments_received_against_that_pledge_this_fy, 0)`, summed. The paid portion already lives in `received`; only the not-yet-paid portion lands here. Clamp is per-opp so an over-paid-this-year pledge can't offset another opp.
- **weighted open asks** = `SUM(pledge_allocations.sub_amount × win_probability)`
  for opportunities with `status='open'`.

**Why this mapping:** opportunity `status` is fully derived (see `pledgeStage.ts`):
`cash_in` = fully paid, `pledge` = written_commitment & not fully paid, `open` =
still in the funnel. So `committed` (status=pledge) and `weighted open asks`
(status=open) are **disjoint by status** — they can never double-count each other.

**Partial-payment dedupe (already done):** a partial payment booked against a
`status='pledge'` opp lands in **received**. To avoid double-counting it, `committed`
is the *unpaid remainder* — server-side it nets each pledge's payments-this-FY out
of that pledge's allocation-this-FY (per-opp, clamped at 0). So a partial payment is
counted once: paid portion in `received`, unpaid portion in `committed`. **Do not**
revert `committed` to the full pledge allocation — that reintroduces the overlap.

**How to apply:** keep server exposing raw components (`received`, `committed`,
`openPipelineWeighted`, `openPipelineAsk`, `goal`) and let the client compose the
projection tile (mirrors the existing money-tile pattern). The tile is a composite
with no drilldown href (like Goal).
