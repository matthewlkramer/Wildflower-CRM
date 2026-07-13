---
name: Dev half of paired prod+dev migrations
description: When a runbook says "run this SQL on prod then dev back-to-back", verify BOTH actually ran — users often run only the prod command.
---

The rule: after handing a human a paired prod+dev `psql` command block, verify each
environment independently (e.g. `to_regclass` / column checks) before closing.
Assume the dev half may not have been run.

**Why:** A drop-table runbook required prod then dev back-to-back (a Publish in
between would resurrect the dropped table on prod from the dev-only copy). The
user reported "Done" but had only run the prod command; dev still held the table,
leaving the project in exactly the dangerous window the runbook warned about.

**How to apply:** The agent can and should apply the dev half itself with
`psql "$DATABASE_URL" ... -f lib/db/migrations/<file>.sql` from bash (dev writes
are allowed; only prod is human-only). Migration files are idempotent by
convention, so re-running is safe. Verify both environments with the runbook's
read-only queries afterward.
