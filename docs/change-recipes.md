# Change Recipe Map

A map for the most common edits in this codebase. Each recipe lists **where to
start**, the **ordered steps**, the **invariants to protect**, and the **fast
check** to run afterward. This exists to remove the rediscovery phase from routine
work — it is a pointer map, not a code dump. Deep detail lives in the code,
[`lib/db/SCHEMA.md`](../lib/db/SCHEMA.md), and the design docs
([`reconciliation-design.md`](reconciliation-design.md),
[`email-intelligence.md`](email-intelligence.md)).

Read this together with the invariants in [`replit.md`](../replit.md) ("Design
principles") — every recipe below is downstream of those.

## The one rule behind every recipe

**Contract-first.** `lib/api-spec/openapi.yaml` is the source of truth. The React
Query hooks (`@workspace/api-client-react`) and the Zod validators
(`@workspace/api-zod`) are **generated** from it. Change the spec, regenerate,
*then* implement. Never hand-edit anything under a `generated/` directory.

```bash
pnpm --filter @workspace/api-spec run codegen   # regenerate hooks + Zod from spec
```

## Architecture gate — required before coding money, status, ownership, or derived-field changes

For any change that touches financial totals, lifecycle status, entity ownership,
or a derived/computed field, answer these questions **before writing code**. If any
answer is "I'm not sure," resolve it first.

1. **What concept is changing?** Name it precisely (not "the reconciliation thing" —
   "the derived queue status for a staged QB payment").
2. **Where is its single authoritative representation?** One schema column, one
   deriver function, one service boundary — identify it by file and name.
3. **Are there other stored or derived representations of the same fact?** List them.
   If yes, does the change update ALL of them — or better, can it eliminate one?
4. **Is the proposed edit using a deprecated, transitional, or frozen path?** If yes,
   stop. Use the current authority or get explicit approval to use the legacy path
   as a temporary bridge with a documented removal condition.
5. **Can the fix be made at the shared derivation or mutation boundary** (e.g.
   `derivedStatus.ts`, `deriveOppFields`, `applyGiftQbTieMany`) instead of at one
   call site?
6. **What invariant test proves the system is still correct?** Name it. If none
   exists, does one need to be added?
7. **If this adds technical debt, what exact condition removes it?** Write that
   condition down before coding.

Stop and reassess (do not proceed with a local patch) if any of these is true:
- The same fact is read from or written to more than one table or field.
- The fix requires updating more than one copy of equivalent logic.
- The fix would add a pointer, status field, duplicated derivation, or fallback.
- A field the fix depends on is marked frozen, deprecated, or dual-write-only.

In those cases, propose the smallest consolidation that removes the duplication first.
Get explicit user approval before treating any such patch as "temporary."

## The fast checks (run these, not a full rebuild)

Each is a registered validation check and also a root `check:*` script. First run
warms the cache (slow); later runs are seconds.

| Check      | Root script          | Use after…                                   |
|------------|----------------------|----------------------------------------------|
| `codegen`  | `pnpm check:codegen` | editing `openapi.yaml`                        |
| `libs`     | `pnpm check:libs`    | editing any `lib/*` (build before leaf checks)|
| `api`      | `pnpm check:api`     | editing API server code                       |
| `web`      | `pnpm check:web`     | editing CRM frontend code                     |
| `test-api` | `pnpm check:test-api`| API logic changes                             |
| `test-web` | `pnpm check:test-web`| frontend logic changes                        |
| `full`     | `pnpm check:full`    | before finishing / when unsure                |

Note: never run `codegen` alongside a `web`/`api` check in the same breath — it
regenerates the imported generated dir mid-typecheck and produces false
missing-import errors. Run `codegen` first, let it finish, then the leaf check.
If a leaf check reports missing `@workspace/*` types, run `libs` first (stale lib
declarations), then re-run the leaf check.

---

## Recipe 1 — Add a field to an existing entity, end to end

Add a new column to a table and surface it through the API and the UI.

**Start in:** `lib/db/src/schema/<entity>.ts`

1. **Schema column.** Add the column to the Drizzle table in
   `lib/db/src/schema/<entity>.ts`. Make it **nullable / defaulted** — existing
   rows predate it. (Re-export is automatic via `schema/index.ts`.)
2. **Reviewable migration file.** Add an idempotent
   `lib/db/migrations/NNNN_<name>.sql` using `ADD COLUMN IF NOT EXISTS` (see
   `0006`, `0017` as precedent). This is **required** even though Publish also
   diffs columns — code review rejects an additive column with no migration file.
   See Recipe 4 for the file + runbook convention.
3. **Push to dev + rebuild db declarations.**
   ```bash
   pnpm --filter @workspace/db run push        # apply to dev DB
   cd lib/db && pnpm exec tsc -p tsconfig.json # refresh composite lib declarations
   ```
   Skipping the second command leaves stale declarations that show up as
   "property does not exist" on leaf typechecks.
4. **OpenAPI schema.** Add the field to the entity's response schema *and* its
   `*Input` / `*Update` body schemas in `lib/api-spec/openapi.yaml`. Nullable
   fields use `type: ["<type>", "null"]` (OpenAPI 3.1).
5. **Codegen.** `pnpm --filter @workspace/api-spec run codegen` regenerates the
   hooks and Zod. → **verify with `codegen`.**
6. **Server route.** In `artifacts/api-server/src/routes/<entity>.ts`, add the
   column to the list/detail `select` projection (route responses are plain
   `res.json` — a full-row select leaks columns, so read through the scrubbed
   projection) and accept it in the create/PATCH handler
   (`parseOrBadRequest(<Body>, req.body, res)`). → **verify with `api`.**
7. **Frontend.** Surface it in `artifacts/wildflower-crm/src` — the detail
   view/edit form under `pages/` or `components/`, using the regenerated hook.
   For a list column, see Recipe 2. → **verify with `web`.**

**Invariants to protect:** additive/non-destructive (nullable, no data rewrite);
migration file required; deprecated columns must never leak into a response
projection; keep dev DB and prod schema convergent (Publish diffs the *dev DB*,
so a stale dev DB proposes destructive reverts).

**Verify with:** `codegen` → `api` → `web` (and `libs` first if a leaf check
reports missing `@workspace/*` types).

---

## Recipe 2 — Add a filter or column to a list page

The 4 entity list pages (organizations, people, gifts, opportunities) share a
filter + column-chooser pattern persisted in saved views.

**Start in:** the page under `artifacts/wildflower-crm/src/pages/` (e.g.
`funding-entities.tsx`, `people.tsx`) and the shared helpers `lib/filters.tsx` /
`lib/columns.tsx`.

**Add a filter:**
1. **Server route.** In `routes/<entity>.ts`, read the new query param and append
   a Drizzle clause to the `filters` `SQL[]` array (array columns → `@>` / `&&`,
   never `= ANY(...)`). Use `parseBoolQuery`/`normalizeArrayQuery` from
   `lib/helpers.ts` for booleans/arrays.
2. **Spec + codegen.** Add the query param to the operation in `openapi.yaml`,
   then `codegen`.
3. **Page state.** Add a `usePersistedState` value for the filter in the page.
4. **Filter registry.** Add a `FilterDef` (`key`, `label`, `render`, `active`,
   `clear`) to the page's `filters` array, and pass the value into the `useList…`
   hook params.

**Add a column:**
1. **Server SELECT.** If the data isn't already returned, add it to the route's
   list `select` projection.
2. **Column registry.** Add a `ColumnDef` (`key`, `label`, `cell`) to the page's
   `buildColumns`; set `defaultVisible: false` for opt-in columns.

**Saved-view persistence is automatic:** `hooks/use-saved-views.ts` captures the
whole filter/column/sort state into `saved_views.state` (jsonb) via
`routes/savedViews.ts`. New keys are picked up on the next "Save View";
`stripNulls` / `shallowEqualObject` keep views predating the new filter
compatible (a null-at-default view keeps opt-in filters hidden).

**Invariants to protect:** saved-view back-compat (default = null so old views
don't force-show new filters); array columns use GIN array operators; default
sort order must mirror the displayed name and end with an id tiebreaker for
stable pagination.

**Verify with:** `codegen` (if the spec changed) → `api` → `web`.

---

## Recipe 3 — Add a new API endpoint

**Start in:** `lib/api-spec/openapi.yaml`

1. **Spec first.** Add the `paths:` entry with a unique `operationId`, a `tags`
   entry, parameters, and responses. Put every request body in
   `components/schemas` and `$ref` it — name it after the **entity**
   (`NoteInput`), never `<OperationId>Body` (that name collides with Orval's
   auto-emitted Zod schema → TS2308). Reuse shared param `$ref`s
   (`#/components/parameters/Limit`, `Page`, `IdPath`, `IncludeArchivedQuery`).
2. **Codegen.** `pnpm --filter @workspace/api-spec run codegen`. → **verify with
   `codegen`.**
3. **Route file.** Add `artifacts/api-server/src/routes/<name>.ts`. Validate
   input with the generated Zod via `parseOrBadRequest(<Schema>, req.body, res)`
   (pass `req.body`/`req.query`, never `req` — the wrong call type-checks but
   always 400s at runtime). Use `req.log`, never `console.log`.
4. **Register it.** Import and `router.use(...)` in
   `artifacts/api-server/src/routes/index.ts`. Mind auth ordering — sub-routers
   apply `requireAuth` at module top, so anonymous endpoints must mount before
   auth-gated routers (see the `emailTrackingRouter` comment).
5. **Client usage.** Consume the generated hook from `@workspace/api-client-react`
   in the frontend (for cache invalidation, `invalidateQueries` needs the full
   `/api` key prefix; use `get<Name>QueryKey(params)`).

**Invariants to protect:** contract-first (spec before route); body schema
naming (entity-shaped, not operation-shaped); all routes require auth unless
deliberately mounted early; Zod validation on every input.

**Verify with:** `codegen` → `api` (+ `test-api` if it carries logic).

---

## Recipe 4 — Add or change a database column with a production migration

The agent **cannot** write to prod. Schema/code ship via Publish; every prod
*data* change is a reviewed, idempotent SQL file a human applies.

**Start in:** `lib/db/migrations/`

1. **Schema + dev** — do the Drizzle change and dev push/rebuild first (Recipe 1
   steps 1–3).
2. **Write the migration file** `NNNN_<name>.sql` (next number in sequence).
   Every statement idempotent: `ADD COLUMN IF NOT EXISTS`, `CREATE … IF NOT
   EXISTS`, guarded backfills. Non-destructive by default. A file header
   comment must state: what it does, why it's safe, and the exact apply command.
3. **Runbook for anything non-trivial** — pair the SQL with
   `NNNN[-MMMM]_<name>_RUNBOOK.md` describing order of operations, especially
   the schema-before-code-before-backfill ordering (new code that selects a
   missing column 500s until the column lands; a new enum value can't be used in
   the same transaction it's added in, so split enum-add and enum-use across
   files/commits).
4. **Apply order:** Publish (schema diff) runs **first**, then the human applies
   the data SQL — a seed/backfill dies "relation does not exist" otherwise.
5. **Apply command (give this verbatim, using `$PROD_DATABASE_URL` and the
   repo-root-relative path):**
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/NNNN_<name>.sql
   ```
   Do **not** put `BEGIN`/`COMMIT` inside a file applied with `psql -1` (the flag
   already wraps it in one transaction).

**Invariants to protect:** non-destructive + idempotent; human-applied to prod;
Publish diffs the dev DB (reconcile dev forward before publishing or it proposes
destructive reverts); Publish never runs `CREATE EXTENSION` (pg_trgm etc. need a
separate manual file); deprecate-then-drop for removals (keep the column
physical + `@deprecated`, drop in a later migration once nothing reads it).

**Verify with:** `libs` + `api`/`web` for the code side; the SQL itself is
reviewed by a human and applied by hand (never run against prod by the agent).

---

## Recipe 5 — Add or change a computed / derived field or response shape

Derived values are computed in one place and often carry recompute / tie / cache
discipline. **Never** persist a value that has an authoritative derivation.

**Start in:** the derivation helper in `artifacts/api-server/src/lib/`:
- Opportunity status / pledge stage → `pledgeStage.ts` (`deriveOppFields`).
- Gift ↔ QuickBooks tie status → `giftQbTie.ts` (`applyGiftQbTieMany`).
- Revenue coding → `revenueCoding.ts` / `@workspace/api-zod`'s
  `deriveRevenueCoding`.
- Gift payment/settled/fee/off-books summary → `giftFinalAmount.ts`.
- Reconciliation lanes/graph → `reconciliationLanes.ts`,
  `reconciliationGraph.ts`.

1. **Change the deriver** (the single source). If it's a fixed-point deriver
   (`deriveOppFields`), keep it idempotent — running it twice must not change the
   result.
2. **Mirror any SQL backfill** in lockstep (e.g.
   `scripts/backfill-derived-opp-fields.ts` / the matching `_RUNBOOK` migration)
   so out-of-band rows converge to the same result the deriver produces.
3. **Recompute at every mutation** that can change an input: a persisted-but-
   derived field (like `quickbooks_tie_status`) goes silently stale if any
   link/amount mutation doesn't re-run its deriver.
4. **Bump the cache key** in lockstep if the response shape of a cached
   driver-tree/analytics endpoint changes (a stale key serves the old shape).
5. **Spec + codegen** if the response shape changes at all → **verify with
   `codegen`.**

**Invariants to protect:** status is calculated, never hand-written (only
`loss_type` is user-settable); TS deriver ↔ SQL backfill parity; persisted-
derived fields recompute on every input mutation; revenue and loan_capital stay
parallel tracks (never fold into one rollup); dual-write→backfill→read-flip only
flips reads after parity runs on **prod**, not just dev.

**Verify with:** `api` + `test-api` (derivers carry unit tests, e.g.
`derive-opp-fields.test.ts`, `gift-qb-tie.test.ts`); `codegen`/`web` if the shape
reached the client.

---

## Recipe 6 — Add or change a validation rule / invariant

Cross-cutting invariants (Donor XOR, etc.) live in **env-neutral** validators
shared by both the server and the browser.

**Start in:** `lib/api-zod/src/index.ts`

1. **Add / edit the validator** (`validateOppInvariants`,
   `validateGiftInvariants`, or a new one) in `lib/api-zod/src/index.ts`. Keep it
   **environment-neutral** — this package is imported by the Express server *and*
   the React app, so no `node`/DOM/URL globals. Validate with pure logic (regex,
   `superRefine`); match Postgres semantics (e.g. `num_nonnulls` counts any
   non-null incl. empty string).
2. **PATCH re-validates merged state.** Every PATCH route must validate
   `{ ...existingRow, ...body }`, not the body alone — a partial PATCH can pass
   body-only validation and still violate the merged invariant.
3. **Wire it into the routes** that create/patch the entity in
   `artifacts/api-server/src/routes/<entity>.ts` (return 400 via the validator's
   issues, so the API answers 400 instead of a DB 500).
4. **Mirror the DB CHECK** where one exists — the API validator exists to return
   400 before the DB returns 500; the two must agree.
5. **Rebuild lib declarations** after editing `lib/api-zod`
   (`pnpm run typecheck:libs`) before leaf checks.

**Invariants to protect:** api-zod stays env-neutral (server + browser); PATCH
re-validates merged post-update state; API validator and DB CHECK agree; Donor
XOR (exactly one donor FK) holds at DB, API, and merged-PATCH layers.

**Verify with:** `libs` → `api` + `test-api` (+ `web` if the frontend also runs
the validator).
