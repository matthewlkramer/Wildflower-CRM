---
name: Drizzle subquery alias ordering
description: Outer ORDER BY/WHERE over a Drizzle .as() subquery must reference the alias columns, not the base table.
---

When a Drizzle query wraps a table in a subquery via `.as("alias")` (e.g. a
`selectDistinctOn(...)` dedup wrapped and then selected from), the OUTER query's
`ORDER BY` / `WHERE` / projections must reference the **subquery alias columns**
(`alias.col`), NOT the base table object (`baseTable.col`).

**Why:** the outer FROM clause is the alias only. Referencing the base table in
the outer scope generates SQL like `... FROM (...) "deduped" ORDER BY
"calendar_events"."start_at"`, which Postgres rejects at runtime with
`error: missing FROM-clause entry for table "calendar_events"` → the route 500s.
This is an environment-independent SQL-construction bug, but it commonly first
surfaces in production simply because that's where the endpoint gets exercised;
it reproduces identically against the dev DB.

**How to apply:** define the `outerOrderBy` (and any outer filters) AFTER the
`.as()` subquery is created and key them off the subquery handle
(`asc(deduped.startAt)`), since the alias handle isn't in scope until then.
Verify by running the generated SQL against the real DB — a passing typecheck
will NOT catch this (the base-table column reference is type-valid).
