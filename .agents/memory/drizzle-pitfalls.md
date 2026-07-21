---
name: Drizzle ORM SQL pitfalls
description: Seven runtime-only Drizzle/Postgres footguns invisible to TypeScript and unit tests — array casts, sql-template parens, column qualification, ORDER BY literals, subquery alias collisions, alias ordering, and .desc() index churn.
---

All of these bugs are invisible to TypeScript and unit tests. Only a query-executing
integration test (boot `app.listen(0)` + fetch, or `db.execute`) or a live DB catches them.

---

## 1. ANY(array) cast pitfall → use inArray()

A JS array interpolated in a drizzle `sql` template (`${ids}`) renders as a **row
constructor** `($1, $2, $3)`, not a Postgres array:

```ts
// WRONG — typecheck passes, runtime ERROR: "cannot cast type record to text[]"
sql`${col} = ANY(${ids}::text[])`
```

**Fix:** use `inArray(col, ids)` — idiomatic, safe, handles empty arrays. Or build an
explicit array literal with `sql.join`. Treat any `ANY(${jsArray}::text[])` in the
codebase as a latent runtime 500 — sweep with grep when fixing one instance (a second
batch was found in the email-intelligence thank-you detector long after the first fix;
error there was "malformed array literal"). DB-touching route logic needs an integration
test that actually executes the query.

---

## 2. sql`` outer-paren footgun → runtime 42601

A leading `(` that intends to wrap a whole multi-line predicate is silently closed by the
first inner parenthesized OR-group. Everything after sits at depth 0, and the final `)` is
unbalanced:

```sql
-- WRONG: leading ( closed by OR-group, trailing ) is stray → Postgres 42601
sql`(
    (a) OR (b) OR (c)
  )
  AND x IS NOT NULL
  AND (subquery) IS NULL)`  -- stray trailing paren

-- CORRECT: leading ( wraps only the OR-group
sql`(
    (a) OR (b) OR (c)
  )
  AND x IS NOT NULL
  AND (subquery) IS NULL`   -- no trailing )
```

Invisible to typecheck AND unit tests. Only an endpoint that executes the rendered SQL
catches it. Any consolidated/shared predicate builder needs at least ONE integration test
that exercises it end-to-end.

---

## 3. sql`` top-level select field unqualifies column (verified drizzle-orm 0.45.1)

Bare `${table.col}` in a `sql` template renders **fully qualified** everywhere — EXCEPT
when passed directly as a `.select({...})` field value, where it renders UNQUALIFIED.
An unqualified column in a correlated EXISTS silently binds to the INNER table:

```ts
// in a correlated EXISTS inside .select(), ${giftsAndPayments.id} renders as bare "id"
// → binds to staged_payments.id instead → EXISTS is effectively always false
```

**Fix:** wrap in `` sql`(${fragment})` `` when using as a `.select()` field.

**Before "fixing" any correlated subquery:** render actual SQL via
`new PgDialect().sqlToQuery(...)` and confirm the emitted text is wrong. Most bare
`${table.col}` interpolations qualify correctly. The `alias()`'d form
(`alias(giftsAndPayments, 'g')` then `${g.id}`) was NOT re-verified — treat any
"buggy correlation" claim as a hypothesis to confirm, never a fact.

---

## 4. ORDER BY bare-literal ordinal → Postgres 500

A bare numeric literal in `.orderBy()` (e.g. `asc(sql\`0\`)` as a "no-op" placeholder)
renders `ORDER BY 0` — Postgres treats it as a **column ordinal position**, not a
constant. Position 0 (or any out-of-range position) → runtime 500.

```ts
// WRONG
const orderBy = [hasAmount ? asc(amtCol) : asc(sql`0`)];  // → ORDER BY 0

// CORRECT: build conditionally, always end with a real column tiebreaker
const orderBy: SQL[] = [];
if (hasAmount) orderBy.push(asc(sql`ABS((${col})::numeric - ${amt})`));
query.orderBy(...orderBy, desc(dateCol)); // dateCol is always a real column
```

---

## 5. Joined subqueries sharing a .as() alias → "column X is ambiguous"

Two Drizzle subqueries joined together that expose a column via the SAME
`sql\`...\`.as("x")` string cause Postgres to 500 with `column reference "x" is
ambiguous` — Drizzle renders the join ON using the bare alias, not `subq."x"`.

**Fix:** give each subquery a distinct `.as()` alias string (e.g. `"pledged_opp_id"` vs
`"paid_opp_id"`). TypeScript property names and join references can stay the same; only
the rendered SQL alias must differ. TypeScript won't catch it — first surfaces in prod
when the endpoint is exercised.

---

## 6. Outer ORDER BY / WHERE over a .as() subquery must use alias columns

When a query wraps a table via `.as("alias")`, the OUTER query's `ORDER BY` / `WHERE` /
projections must reference the **subquery alias columns** (`alias.col`), NOT the base
table object (`baseTable.col`). Referencing the base table in the outer scope →
`missing FROM-clause entry for table "..."`. Define `orderBy` and filters AFTER the
`.as()` subquery is created so the alias handle is in scope.

---

## 7. .desc() on an index → perpetual Publish/push churn

Do **not** use `.desc()`, `.asc()`, or NULLS modifiers in a Drizzle index column list.

**Why:** drizzle-kit 0.31.x records DESC in its snapshot but its CREATE INDEX generator
**omits the DESC keyword**. Combined with Replit Publish diffing the **dev DB** vs the
prod DB (not the schema source), dev ends up DESC and prod ends up ASC — they never
converge, so every Publish issues the same DROP+CREATE forever.

**Fix (both steps required):**
1. **Code:** remove `.desc()` — plain columns only.
2. **Dev DB:** recreate the affected index as ascending (`DROP INDEX` + `CREATE INDEX`
   without DESC) so dev matches prod. Prod is typically already ascending from the churn
   CREATEs — no prod change needed.

Postgres scans a btree backward for `ORDER BY col DESC` at identical cost; no perf
penalty to plain ascending. Verify code == dev == prod via `pg_indexes.indexdef`.

## Raw sql subquery in SELECT list: never interpolate `${table.col}`
Inside a raw `sql` scalar subquery placed in the SELECT list of a join-less query, `${outerTable.col}` renders as a bare unqualified `"col"`, which Postgres resolves to the SUBQUERY alias (e.g. `srcl.id`) — reads silently return wrong/null values with no error. Use literal qualified identifiers instead (`"stripe_staged_charges"."id"`). Verified via `.toSQL()`; the equivalent hand-written psql works, so only the rendered SQL exposes it. Unit tests should assert the rendered SQL contains the qualified name.
