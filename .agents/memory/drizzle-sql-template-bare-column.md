---
name: drizzle sql-template bare-column correlation footgun
description: Interpolating a Column into a drizzle sql`` template renders it UNQUALIFIED, silently breaking correlated subqueries when the inner table shares the column name.
---

# drizzle `sql` template renders interpolated columns UNQUALIFIED

In drizzle-orm (pg, observed on 0.45.1) interpolating a `Column` into a
`` sql`...` `` template renders the **bare quoted column name** (`"id"`), NOT
table-qualified (`"gifts_and_payments"."id"`). This holds for:
- a bare table-object column: `${giftsAndPayments.id}` → `"id"`
- a non-primary table column: `${giftAllocations.giftId}` → `"gift_id"`
- **even an `alias()`'d column**: `alias(giftsAndPayments,"g")` then `${g.id}` → `"id"` (the alias name "g" is NOT used)

`inArray(table.col, ...)` and other drizzle operators DO qualify (`"table"."col"`);
only the `sql` template interpolation goes bare.

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

## Known-affected sites (as of discovery; verify before relying)
All share `${giftsAndPayments.id}` / `${stagedPayments.id}` / `${g.id}` inside a
correlated subquery over a table that has its own `id`/`gift_id`:
- `lib/giftQbTie.ts` applyGiftQbTieMany (direct/group/split QB-link detection) — under-detected ALL ties, persisted `quickbooks_tie_status` was `missing` for genuinely-tied gifts.
- `routes/giftsAndPayments.ts` — gift-detail `quickbooksStagedPaymentId`/linked field, list `linked`/`unlinked` filter, AND the allocation-based entityId/grantYear/usage list filters (`FROM gift_allocations WHERE "gift_id" = "id"`).
- `routes/financialCorrections.ts`, `routes/quickbooks/shared.ts`, `routes/reconciliation/cards.ts` candidate-matching.

**Why it matters:** the `payment_applications` ledger read-cutover flips some of these
to the ledger via correctly-correlating raw SQL, which simultaneously FIXES this bug —
so "rollback to legacy" means rollback to the buggy reads. The non-QB sites (gifts-list
allocation filters) are a separate latent bug to report, not silently fold into a flip task.
