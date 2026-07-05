---
name: drizzle sql-template outer-paren footgun
description: A leading "(" in a multi-line drizzle sql`` predicate is silently closed by an inner parenthesized OR-group, making a trailing ")" stray → runtime 42601, invisible to typecheck and to unit tests.
---

# The footgun

A predicate builder written as a multi-line `sql\`...\`` template like:

```
sql`(
    (a) OR (b) OR (c)
  )
  AND x IS NOT NULL
  ...
  AND (subquery) IS NULL)`   // <-- stray trailing )
```

looks like the leading `(` wraps the WHOLE predicate. It does NOT. The `)` that
closes the donor/OR-group on its own line closes the leading `(`. Everything after
(`AND x ... AND (subquery) IS NULL`) then sits at depth 0, and the final `)` is
**unbalanced** → Postgres `syntax error at or near ")"` (code 42601) at render time.

**Correct shape (mirror a known-good sibling):** the leading `(` wraps only the
OR-group; the rest is AND-chained with **no** trailing paren:

```
sql`(
    (a) OR (b) OR (c)
  )
  AND x IS NOT NULL
  ...
  AND (subquery) IS NULL`   // no trailing )
```

# Why it hides

- **typecheck can't see it** — it's string content inside a template literal.
- **Unit tests can't see it** — pure band/bounds helpers don't execute SQL.
- **Hand-written prod-verification queries can't see it** — you naturally balance
  parens when writing SQL by hand; the drizzle *render* is what's unbalanced.

The only thing that catches it is a test (or endpoint) that **executes the rendered
SQL** against a real DB.

# How to apply

- Whenever you add/edit a `sql\`\`` predicate builder that embeds a parenthesized
  OR-group followed by more `AND` clauses, count parens on the *rendered* output,
  and copy the exact paren shape of an existing working sibling builder.
- Any consolidated/shared drizzle predicate builder needs at least ONE integration
  test that hits an endpoint which executes it (not just unit tests of the pure
  helpers). A subquery embedded in the SELECT list breaks *every* query on that
  route, so a single cards/list integration test surfaces it immediately.
