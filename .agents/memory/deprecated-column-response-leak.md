---
name: Deprecated-column response leaks (no outbound Zod stripping)
description: Why removing a column from the OpenAPI contract is NOT enough in this api-server — the still-physical Drizzle column leaks through every full-row select that reaches the client.
---

# Deprecating a DB column without leaking it in responses

**Rule.** This api-server returns plain `res.json(row)` — there is **no outbound
Zod stripping**. So when you "remove" a column the prod-safe way (invariant #7:
keep it `@deprecated` in the Drizzle schema, ship the physical DROP as a separate
human-applied SQL migration), the column is **still physically present** on the
table until the DROP runs. Every response surface that serializes a *full row*
(`db.select().from(t)` with no projection arg, or a bare `.returning()`) will
include the deprecated field even though the OpenAPI/generated types no longer
declare it. Removing it from the contract alone does nothing at runtime.

**Why.** This bit us moving `countsTowardGoal` to allocations and deleting
`syncGap` from `staged_payments`. It took ~6 architect passes because the leak
sites are scattered and easy to miss:
- nested response arrays (e.g. `GET /opportunities-and-pledges/:id` returns a
  `payments: db.select().from(giftsAndPayments)` array),
- generic helpers (`archiveOne`/`unarchiveOne` did a bare `.returning()` and
  `res.json`'d the row),
- cross-route "gift echo" responses (Stripe / Donorbox / QuickBooks
  reconcile+create paths that re-read and return the gift header),
- create/PATCH/merge/split `.returning()`.

**How to apply.** While a column is `@deprecated`-but-still-physical, route **all**
response-facing reads of the affected table through ONE exported, scrubbed column
projection and reuse it everywhere (`giftHeaderColumns` in
`routes/giftsAndPayments.ts`; `stagedReturnColumns` / `stagedSelect` /
`giftCandidateSelect` in `routes/quickbooks/shared.ts`; generic
`archiveOne`/`unarchiveOne` takes an optional `responseColumns` projection,
default = bare `.returning()`, so the other ~9 archive tables are unchanged and
gift callers opt in).

**Status of the original case (counts_toward_goal / sync_gap).** The physical DROP
finally shipped (migration 0094). Those columns are gone from the schema, so the
named projections above were reverted to plain `getTableColumns(...)` full sets
(no `Omit`/destructure) — value-identical, kept only as greppable named exports.
The **rule still applies to the NEXT** deprecated-but-physical column: scrub through
one projection until its DROP runs, then simplify back.

To find leaks, grep every `\.from(<table>)` and `\.returning(`, then keep only
the ones whose result reaches `res.json`. Bare full-row selects used purely for
locking (`FOR UPDATE`), validation, merge/derivation, or sync workers are SAFE —
they never serialize. An exhaustive sweep + architect review is worth it; a
single missed nested array re-opens the leak. After the manual DROP finally runs,
the scrubbed projections become harmless no-ops (safe to keep).
