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

**How to apply.** Route **all** response-facing reads of an affected table
through ONE exported, scrubbed column projection and reuse it everywhere:
- gift header → `giftHeaderColumns` (exported from `routes/giftsAndPayments.ts`,
  = `getTableColumns(giftsAndPayments)` minus the deprecated field).
- staged rows → `stagedReturnColumns` / `stagedSelect` / `giftCandidateSelect`
  (in `routes/quickbooks/shared.ts`).
- generic `archiveOne`/`unarchiveOne` takes an optional `responseColumns`
  projection (default = bare `.returning()`, so the other ~9 archive tables are
  unchanged; gift callers opt in).

To find leaks, grep every `\.from(<table>)` and `\.returning(`, then keep only
the ones whose result reaches `res.json`. Bare full-row selects used purely for
locking (`FOR UPDATE`), validation, merge/derivation, or sync workers are SAFE —
they never serialize. An exhaustive sweep + architect review is worth it; a
single missed nested array re-opens the leak. After the manual DROP finally runs,
the scrubbed projections become harmless no-ops (safe to keep).
