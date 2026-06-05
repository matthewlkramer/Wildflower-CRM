---
name: QuickBooks fiscally-sponsored project exclusion
description: Why the fiscally_sponsored staged-payment exclusion is a project-identity rule (no donation guard) and how its marker list works.
---

The QB staged-payment classifier excludes money belonging to a separate fiscally
sponsored project (first instance: "Embracing Equity") via the
`fiscally_sponsored` exclusion reason.

**Rule shape:** it is a project-IDENTITY rule, NOT a noise rule. It runs BEFORE
the donation-first guard and fires even when the row carries a real donation
line — because the entire payment belongs to the other project, a donation coded
to it is still the other project's money. Contrast with the line-based noise
rules (interest/tax/guaranty/earned/other-revenue) which are donation-guarded.

**Why class matters:** fiscally sponsored projects are tracked in QuickBooks by a
**Class**. The classifier historically did not read class data at all, so adding
this rule required threading `lineClasses` into the classifier input at both call
sites (ingestion sync + admin reclassify). The marker is matched as a
case-insensitive SUBSTRING across every captured field (class, payer, item,
account, line description, memo), not class-only — intentional breadth, accepted
false-positive risk.

**How to apply / extend:**
- The marker list is code-owned (a substrings array in the classifier). To add
  another fiscally sponsored project, add its distinctive name there AND add the
  matching OR-clause to the SQL backfill — the TS classifier and the SQL backfill
  must stay in lockstep (same invariant as the other QB exclusion rules).
- Adding/extending an exclusion reason needs the two-file ADD VALUE enum split
  (enum-add run withOUT `-1`, backfill run WITH `-1`) plus OpenAPI enum + the
  `excludedByReason` counts object + the route default-counts map + the UI label
  map — miss any and codegen/UI drift.
- Already-approved historical rows are NOT reclassified (backfill touches only
  `pending`; in-app reclassify skips approved). Correcting them is a manual,
  per-row reject/unwind through the app, documented in the migration runbook.
