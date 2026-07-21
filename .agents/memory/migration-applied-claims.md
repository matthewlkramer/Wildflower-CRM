---
name: Migration "already applied" claims can be false
description: Verify a migration's applied-in-prod/dev status by probing both DBs, never by trusting the file's header comment.
---

A drop-migration file's header claimed its drops were "already in effect in prod";
probing on 2026-07-21 showed all seven columns still present in BOTH dev and prod
(and the task brief itself was wrong that no drop file existed — the drop was
bundled in an existing multi-column migration). There is no applied-migrations
ledger in this repo, so file comments and task descriptions are the ONLY written
record — and both can be stale or wrong.

**Why:** acting on the false claim would have produced a duplicate drop file
(violating the one-authority invariant) and left the real pending migration
unapplied, letting Publish keep re-creating retired columns.

**How to apply:** before writing any "missing" migration, (a) grep
`lib/db/migrations/` for the column — the drop may already exist in a bundled
file; (b) probe information_schema in BOTH dev and prod (prod read-only via
executeSql, cast enums ::text) to establish the real applied state; (c) when a
header claim is proven false, correct the file and record verified state + date
in its runbook instead of adding a new file.
