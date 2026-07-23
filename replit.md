# Wildflower Fundraising CRM — Agent Operating Guide

## Purpose

Wildflower CRM is the fundraising system of record for pipeline, commitments,
payments, donor communications, and financial reconciliation, replacing Copper.
The monorepo uses TypeScript, React/Vite, Express 5, PostgreSQL/Drizzle, Clerk,
OpenAPI/Orval, and pnpm workspaces.

This file is the stable operating contract for coding agents. Keep it short. Put
subsystem design, implementation status, and troubleshooting detail in the linked
documents rather than expanding this file.

## Start every task this way

1. Read this file.
2. Read [`docs/README.md`](docs/README.md) and the canonical document for the
   subsystem being changed.
3. Inspect the current diff, the relevant schema, and the relevant API contract
   before proposing code.
4. State, briefly: the concept being changed; its current authoritative
   representation; the shared mutation or derivation boundary; the smallest
   relevant tests.
5. Only then edit code.

Do not load the entire `.agents/memory/` directory. Start with
[`.agents/memory/MEMORY.md`](.agents/memory/MEMORY.md), then read only the topic
files relevant to the task.

## Authority order

When sources disagree, use this order and surface the conflict instead of guessing:

1. The user's explicit instruction for the task.
2. Canonical business-rule documents identified in `docs/README.md`.
3. Ratified architecture decisions and current implementation-status documents.
4. Drizzle schema (`lib/db/src/schema/`) and database constraints for the current
   physical model.
5. `lib/api-spec/openapi.yaml` for the public API contract.
6. Shared domain services and derivation modules.
7. Route and UI implementations.
8. `.agents/memory/` implementation lessons.
9. Historical documents and deprecated code.

Schema and code describe what exists. Business-rule and architecture documents
describe what should exist. When those differ, do not silently treat the current
implementation as the intended design — record the gap in the subsystem's
current-status document.

## Non-negotiable invariants

1. **Contract first.** Change `lib/api-spec/openapi.yaml`, regenerate, then
   implement. Never hand-edit generated files.
2. **Header plus allocations.** Opportunity/pledge and gift/payment headers hold
   identity and lifecycle facts. Scope, recipient, fiscal year, restriction,
   intended use, project, region, and sub-amount live on allocation rows.
3. **One authority per derived fact.** Lifecycle, reconciliation, totals, and
   completeness are derived once. Do not add stored status columns, copied SQL
   CASE expressions, route-local derivations, or frontend fallback heuristics for
   facts that already have an authority. Opportunity status is fully derived; the
   user-set lifecycle inputs are `loss_type` (`dormant`/`lost`) and — on
   cost-reimbursement pledges only — the finance-permitted Close-award action
   (`award_closed_at` + `award_close_reason`), the sole completion path for that
   disbursement model (paid ≥ ceiling never auto-completes it).
4. **Donor XOR.** Every opportunity and gift has exactly one organization,
   individual, or household donor — enforced at the DB, the API, and on merged
   PATCH state.
5. **Loan and revenue remain separate.** `loan_or_grant` is the sole persisted
   classification. `gifts_and_payments.type` and the legacy `fundraising_category`
   model are retired and must not be revived.
6. **Canonical money relationships.** Use:
   - `payment_applications` for payment/evidence unit → CRM gift;
   - `settlement_links` for Stripe payout → QuickBooks deposit;
   - `source_links` for evidence ↔ evidence (implemented; the old
     source-specific pointer columns are dropped — never add a sibling
     pointer column).
7. **Refunds are transaction facts.** A processed refund removes or reduces live
   payment evidence. It does not, by itself, archive the CRM gift, rewrite donor
   intent, or prove the gift was never paid. There is no anticipatory refund
   state — records stay as they are until a refund is actually processed. Follow
   [`docs/workbench-business-rules.md`](docs/workbench-business-rules.md).
8. **Archive by default.** Soft-delete (`archived_at`) is the app-wide default;
   hard deletion is allowed only in an explicitly documented, tested exception.
9. **Production is human-gated.** Agents work on main and dev only and cannot
   write to production. Schema/code ship via user-initiated Publish; every prod
   *data* change is a reviewed, idempotent SQL file in `lib/db/migrations/`
   applied by a human.
10. **Reduction is the architectural success criterion.** Prefer removing an
    authority, write path, fallback, or recomputation call site over adding a new
    representation beside it.

Stop and ask before implementing when a proposed fix:

- updates more than one copy of equivalent logic;
- adds a pointer, status, proposal field, cache, or fallback for an existing fact;
- reads or writes a deprecated, frozen, historical, or dual-write-only field;
- requires a new recomputation call site for a persisted derivative;
- changes money booking, reconciliation grain, donor identity, or lifecycle
  without an invariant test.

## Reconciliation-specific guard

Before any reconciliation change, read:

- [`docs/reconciliation-status.md`](docs/reconciliation-status.md) — what is
  currently implemented and known to be drifting;
- [`docs/workbench-business-rules.md`](docs/workbench-business-rules.md) —
  ratified product semantics (normative even where current code disagrees);
- [`docs/reconciliation-design.md`](docs/reconciliation-design.md) — target money
  and relationship model;
- [`docs/adr-source-link-ledger.md`](docs/adr-source-link-ledger.md) — proposed
  evidence-to-evidence ledger.

Required rules:

- The three semantic columns are donor/purpose (CRM), payment transaction, and
  accounting evidence. One physical record may serve more than one role.
- Link completeness and information completeness are independent signals.
- CRM completeness applies to every CRM card on the row, linked or not. A pledge
  by itself is never complete — completeness requires a CRM gift/payment, whose
  allocation rows are authoritative (pledge allocations are intentions).
- Lost or dormant CRM records never render as CRM cards; cards are only for
  gifts believed won.
- `audit_ready` requires the required QuickBooks documentation to be complete,
  not merely the presence of accounting evidence. The system never writes to
  QuickBooks (pull-only); QB-side documentation is done by a human in QuickBooks.
- Completed-lens membership, counts, displayed status, and available actions must
  derive from the same canonical row state.
- Donorbox is donor/purpose evidence, not transaction evidence.
- Accounting-changing actions require the appropriate finance permission.

Do not extend a known implementation drift described in
`docs/reconciliation-status.md`; repair the canonical boundary first.

## Change workflow

### Routine code change

1. Find the recipe in [`docs/change-recipes.md`](docs/change-recipes.md).
2. Update the canonical contract/schema/deriver first.
3. Reuse the shared write service or transaction boundary.
4. Add or update the narrow invariant test.
5. Run scoped checks while iterating; run the required full checks once before
   finishing.
6. Update canonical documentation and memory in the same change when behavior or
   architecture changed.

### Schema or production-data change

- Additive and nullable/defaulted first.
- Dev loop after editing `lib/db/src/schema/`:

```bash
pnpm --filter @workspace/db run push          # apply to dev DB
cd lib/db && pnpm exec tsc -p tsconfig.json   # refresh composite lib declarations
```

  Stale declarations show up as "property does not exist" on leaf typechecks —
  trust `pnpm run typecheck`, which builds libs first.
- Every schema change also needs a uniquely numbered, idempotent migration file
  in `lib/db/migrations/` (plus a runbook when ordering or data risk is
  non-trivial). Dev schema changes do not prove production readiness.
- Give human-run commands with `$PROD_DATABASE_URL` and a repo-root-relative path:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/<file>.sql
```

  Do not place `BEGIN`/`COMMIT` inside a file applied with `psql -1`.

## Validation

Use the smallest checks that cover the change. Do not run several DB-backed test
commands concurrently; the dedicated test database intentionally serializes them.

| Change | Iteration checks | Before finishing |
|---|---|---|
| OpenAPI contract | regenerate alone, then `pnpm check:codegen` | affected API/web checks |
| Shared library | `pnpm check:libs` + affected changed-scope tests | `pnpm check:full` |
| API server | `pnpm check:api` + `pnpm check:test-api-changed` | `pnpm check:test-api` + `pnpm check:full` |
| Frontend | `pnpm check:web` + `pnpm check:test-web-changed` | `pnpm check:test-web` + `pnpm check:full` |
| Browser flow | component/integration tests first | one focused e2e flow if UI behavior changed |

Run code generation by itself (it mutates the generated dirs; the `codegen`
check is non-mutating):

```bash
pnpm --filter @workspace/api-spec run codegen
```

## Documentation and memory rules

- `replit.md` contains stable rules only; no benchmark counts, migration-phase
  diaries, or one-off incident notes.
- `docs/` contains canonical business rules, architecture, current status, and
  runbooks. Major design docs declare `status` and `last_verified`; see
  [`docs/README.md`](docs/README.md).
- `.agents/memory/` contains durable implementation lessons and routing indexes,
  not competing architecture. Follow `.agents/memory/README.md`.
- When a design changes, update or supersede the old document in the same change.
  Do not leave contradictory "current" statements in multiple files.
- Historical material belongs under an explicit `legacy/` or `archive/` path and
  must not be linked as current guidance.

## Project map

- `lib/db/` — Drizzle schema, DB connection, migrations; `lib/db/SCHEMA.md` is
  the per-table map
- `lib/api-spec/` — canonical API contract (`openapi.yaml`)
- `lib/api-client-react/` — generated React Query client
- `lib/api-zod/` — generated schemas plus shared invariant helpers
- `artifacts/api-server/` — Express API and domain services (port 8080)
- `artifacts/wildflower-crm/` — React frontend (Vite)
- `artifacts/mockup-sandbox/` — design preview server (not deployed)
- `docs/README.md` — documentation authority and subsystem map
- `.agents/memory/MEMORY.md` — selective implementation-memory index

## User working preferences

- Explain material tradeoffs and architectural consequences before a large or
  destructive change.
- Prefer a complete root-cause fix over a convincing local patch.
- In pickers, show blocked rows disabled with the blocking reason; do not hide
  them. Enforcement remains on the write endpoint with specific errors.
- Prod data-migration commands must use `$PROD_DATABASE_URL` (never
  `$DATABASE_URL`) and the full repo-root-relative `.sql` path, copy-pasteable
  from the project root.
- Keep documentation and memory current — archive approaches as they go stale —
  but do not create a new memory file for every task.
