---
name: drizzle ORDER BY bare-literal ordinal footgun
description: A literal number interpolated into a drizzle ORDER BY renders as a column ordinal → Postgres 500
---

Interpolating a bare numeric literal into a drizzle `.orderBy()` (e.g.
`asc(sql\`0\`)` as a "no-op" fallback when a ranking term isn't applicable)
renders as `ORDER BY 0`, which Postgres reads as a **column ordinal position**,
not a constant. Position 0 (or any out-of-range position) → runtime 500
`ORDER BY position N is not in select list`.

**Why:** SQL treats an integer constant in ORDER BY as a 1-based reference to a
select-list column, never as a sort-by-constant. Typecheck and unit tests never
catch it — only a query-executing integration test does.

**How to apply:** Never emit a bare literal into ORDER BY as a placeholder.
Build the order-by list conditionally and push only the terms that are actually
anchored (plus a real column tiebreaker):
```ts
const orderBy: SQL[] = [];
if (hasAmount) orderBy.push(asc(sql`ABS((${col})::numeric - ${amt})`));
if (hasDate)   orderBy.push(asc(sql`ABS(${dateCol} - ${d}::date)`));
orderBy.push(desc(dateCol)); // always a real column
query.orderBy(...orderBy);
```
Same family as the other drizzle sql-template footguns (bare-column, outer-paren).
