---
name: email-intel error-free "Analyzing…" stuck rows
description: Why reopened/never-analyzed pending email-intel proposals never get a proposal, and the only trigger that fixes them.
---

A pending email_intel proposal with `actions_analyzed_at = NULL` AND
`actions_error = NULL` (e.g. one reopened by an operator/SQL, or whose atomic
claim died mid-flight) has NO automatic path to AI analysis and shows
"Analyzing what to do…" forever.

- The scheduled recovery sweep only SELECTS mailboxes that have a row with
  `actions_error IS NOT NULL`, then runs `analyzePendingForUser(phases:["retry"])`
  — error-free rows are never even selected.
- The inline sync fan-out only analyzes rows at detection time; it never
  re-touches pre-existing rows.
- So the ONLY trigger is a manual, owner-scoped one: `POST /email-proposals/:id/retry`
  (or `/revise`), surfaced in the UI as the "Re-analyze" button — which must be
  shown in the `!analyzedAt` branch, not only the error branch.

**Why:** A reopen-via-SQL plan assumed "the scheduled fresh-analysis sweep picks
up NULL rows" — that premise is false; the sweep is retry-only. This is distinct
from the errored-row recovery, which DOES self-heal.

**How to apply:** If reopening proposals in bulk to force re-analysis, do NOT
rely on the scheduler — either drive a path that actually triggers analysis, or
extend the sweep to also cover `pending AND analyzed_at IS NULL AND error IS NULL`.
Note `/retry` does not set `disableAutoSuppress`, so a re-analysis that returns
empty+suppress will auto-ignore the row (the card disappears).
