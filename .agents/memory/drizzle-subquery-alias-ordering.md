---
name: Drizzle subquery alias ordering & collisions
description: Outer ORDER BY/WHERE over a Drizzle .as() subquery must reference the alias columns; and two joined subqueries must never share a column .as() alias string.
---

## Duplicate `.as()` alias across joined subqueries → ambiguous column

When you join two Drizzle subqueries that each expose a column via the SAME
`sql<...>\`...\`.as("x")` string, Drizzle renders the join ON clause (and other
refs) using the **bare alias** (`ON "x" = "x"`), not `subqalias."x"`. Postgres
then 500s with `column reference "x" is ambiguous`. Giving the two subqueries
DISTINCT alias strings (e.g. `"pledged_opp_id"` / `"paid_opp_id"`) fixes it — the
TS property names and join references can stay the same; only the rendered SQL
alias must differ.

**Why:** a `sql().as(name)` aliased column loses its subquery qualification when
referenced from an outer/join scope, so two subqueries sharing the alias name
collide. **How to apply:** never reuse a `.as()` alias string across subqueries
that get joined together; verify against the real DB — typecheck won't catch it
(both `oppId` properties are type-valid). First surfaces in prod only because
that's where the endpoint (e.g. `/api/dashboard-summary`) gets exercised.

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
