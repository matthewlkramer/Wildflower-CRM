---
name: FY Report page reconciles to dashboard bar
description: The FY Report page lists the records behind each fiscal year's progress bar and must mirror fyMetricsFor semantics exactly.
---

# FY Report page (records behind the dashboard goal bar)

The dashboard's "Progress to goal" bar segments (received / committed /
weighted-open) drill into a dedicated **FY Report** page that lists the actual
records behind each of the three buckets, per fiscal year and per track
(Grants/revenue vs Loans/loan_capital).

**The rule:** the report's server query must reproduce `fyMetricsFor`
(`routes/analytics.ts`) bucket semantics *exactly* — received = gift_allocations,
committed = per-opportunity UNPAID pledge remainder (pledged minus paid,
remainder > 0), open = open pledge_allocations. If the two drift, the report
totals stop reconciling with the bar and user trust breaks (the whole point of
the page is "show me the money behind this number").

**Why:** the page exists precisely to make the bar auditable. Any change to how
the dashboard bar computes a bucket must be mirrored in the report route in
lockstep, the same way the QuickBooks TS classifier ↔ SQL backfill must stay
in lockstep.

**How to apply:**
- Entity scope comes from the **global header filter** (`useEntityFilter`), the
  same source the dashboard bar reads — so the report reconciles for ANY number
  of selected entities. Don't forward entity via URL params per-link.
- Track filtering uses `IS DISTINCT FROM 'loan'` for the revenue track (so
  legacy NULLs count as revenue), matching the dashboard split.
- The nav link points at `/fiscal-year-report/current`; the page resolves the
  `current` alias client-side to a concrete `fy<endYear>` slug (Wildflower FY =
  Jul 1–Jun 30 labelled by END year, America/Chicago — mirrors the server's
  `computeCurrentFiscalYear`) and redirects so the URL is shareable.
- The old `/fiscal-year/:fyId` detail page is intentionally kept alongside it.
