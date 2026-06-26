---
name: drizzle sql-template column interpolation qualification
description: Bare table-object columns interpolated into a drizzle sql`` template ARE table-qualified (verified on 0.45.1); the alias() case is the unverified suspect. Re-render with PgDialect before assuming a correlation bug.
---

# drizzle `sql` template column interpolation — VERIFY, don't assume

**Empirically re-tested on the current codebase (drizzle-orm 0.45.1, pg) via
`new PgDialect().sqlToQuery(sql\`...\`).sql`:** interpolating a **bare
table-object column** into a `` sql`...` `` template renders it **FULLY
TABLE-QUALIFIED**, not bare:
- `${opportunitiesAndPledges.id}` → `"opportunities_and_pledges"."id"`
- `${giftAllocations.giftId}` → `"gift_allocations"."gift_id"`
- `${giftsAndPayments.id}` → `"gifts_and_payments"."id"`

So correlated subqueries using bare table-object columns (e.g. the opportunities
route `paidPresence` sum, the worklist predicates in
`artifacts/api-server/src/lib/worklists.ts`) correlate **correctly** — they are
NOT affected by the footgun below.

**Why this entry exists / what to do:** an earlier note claimed bare
interpolation renders UNQUALIFIED (`"id"`) and silently breaks correlation. That
did NOT reproduce for bare table-object columns on 0.45.1. The likely real
suspect is the `alias()`'d-column case (`alias(giftsAndPayments,"g")` then
`${g.id}`), which was NOT re-verified. **Before "fixing" any correlated subquery
on suspicion of this bug, render the actual SQL with `PgDialect.sqlToQuery` and
confirm the emitted text is wrong.** Do not refactor working qualified SQL.

`inArray(table.col, ...)` and other drizzle operators also qualify
(`"table"."col"`).

## Why it's a silent bug
In a **correlated subquery**, an unqualified column resolves in the INNER (nearest)
scope first. If the inner FROM table has a same-named column, the bare name binds
there and SQL scoping does NOT raise "ambiguous column" (ambiguity is only within a
single FROM scope). So:

```
EXISTS (SELECT 1 FROM staged_payments sp WHERE sp.matched_gift_id = ${giftsAndPayments.id})
-- emits: WHERE sp.matched_gift_id = "id"  →  "id" binds to staged_payments.id
-- becomes sp.matched_gift_id = sp.id  →  effectively always false, EXISTS = false
```

The correlation is silently lost; the subquery returns wrong results with no error.
`tsc` and unit tests do NOT catch it (runtime-semantic). Only direct SQL / e2e /
parity against raw `db.execute` reveals it.

**Safe** when the bare name resolves to the right table: top-level WHERE/SELECT over
a single FROM table, OR a correlated subquery whose inner table does NOT have a
column matching the bare rendering (e.g. `WHERE pi.id = ${giftsAndPayments.paymentIntermediaryId}`
→ `"payment_intermediary_id"`, which payment_intermediaries lacks → correlates fine).

## How to fix / avoid
- Do NOT interpolate outer columns into correlated subqueries via `sql` template.
- Prefer raw `db.execute(sql`...`)` writing the whole query as text with explicit
  outer aliases (`FROM gifts_and_payments g ... WHERE pa.gift_id = g.id`); pass
  scalar/array VALUES as params (`g.id = ANY(${ids})`) — values are safe, it's the
  column-as-correlation that breaks.
- Or `sql.raw('"outer_alias"."col"')`, or restructure as a JOIN.

## Previously-suspected sites — RE-VERIFY before trusting "buggy"
An earlier pass flagged these as broken on this footgun. Since bare table-object
interpolation was since shown to QUALIFY, that conclusion is now in doubt for any
site using bare `${table.col}` (vs `alias()`'d). Render each with
`PgDialect.sqlToQuery` before treating it as a bug or "fixing" it:
- `lib/giftQbTie.ts` applyGiftQbTieMany (direct/group/split QB-link detection).
- `routes/giftsAndPayments.ts` — gift-detail linked field, list `linked`/`unlinked`
  filter, allocation-based entityId/grantYear/usage list filters.
- `routes/financialCorrections.ts`, `routes/quickbooks/shared.ts`,
  `routes/reconciliation/cards.ts` candidate-matching.

The genuine footgun (if it exists at all here) is the `alias()`'d-column form,
which remains unverified. Treat any "buggy correlation" claim as a hypothesis to
confirm against emitted SQL, never a fact.
