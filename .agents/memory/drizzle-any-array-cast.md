---
name: drizzle ANY(array) cast pitfall
description: Why `ANY(${jsArray}::text[])` in a drizzle sql template fails at runtime, and what to use instead.
---

Inside a drizzle `sql` template, interpolating a JS array (e.g. `sql\`${ids} ...\``)
renders the array as a **row constructor** `($1, $2, $3)`, NOT a Postgres array.
So `sql\`${col} = ANY(${ids}::text[])\`` compiles fine (typecheck passes) but
throws at runtime: `cannot cast type record to text[]` (only surfaces when the
array actually has elements bound as separate params).

**Why:** the bug is invisible to typecheck and only appears against a live DB, so
it slips past unit tests that don't hit Postgres. It cost a full debugging cycle.

**How to apply:**
- For column membership, use drizzle's `inArray(col, ids)` — idiomatic, safe,
  handles empty arrays.
- If you must stay in raw `sql`, build an explicit array literal:
  `sql\`ARRAY[${sql.join(ids.map((i) => sql\`${i}\`), sql\`, \`)}]::text[]\``
  (the `idArray()` helper in `mergeEntities.ts` does exactly this).
- Treat any `ANY(${jsArray}::text[])` you see in the codebase as suspect — it is
  a latent runtime 500 waiting for a non-empty array.
- DB-touching route logic needs an integration test that actually runs the query
  (boot `app.listen(0)` + fetch, mock `requireAuth`), not just a typecheck.
