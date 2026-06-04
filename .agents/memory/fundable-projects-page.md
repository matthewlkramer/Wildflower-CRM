---
name: Fundable projects page
description: Durable decisions about fundable-project planning fields and progress rollup.
---

# Fundable projects page

**Management is its own page, not Admin.** Fundable-project CRUD lives apart from
Admin (which keeps entities + per-FY goals). Keep them separate when extending.

**Planning fields are nullable by design.** fundable_projects' fundraising/
spending timeframes and fundraising_goal are all nullable so rows seeded before
the columns existed keep loading; the UI flags missing start/goal as "needs
setup" rather than erroring. Don't make them NOT NULL without a backfill.
**Why:** legacy rows predate the columns; a NOT NULL constraint would break reads.

**Goal is a decimal string end-to-end.** fundraising_goal is numeric(14,2),
carried as a string through JSON to preserve precision — mirrors
fiscal_year_entity_goals.goalAmount. Never coerce to JS number in transit.

**Progress endpoint must LEFT JOIN from fundable_projects.** The
`/fundable-projects-progress` contract returns EVERY project (raised "0" when it
has no allocations), so it must drive from fundable_projects LEFT JOIN
gift_allocations — not group gift_allocations alone (which silently drops
zero-allocation projects and breaks the documented contract).
