# Agent Memory Routing Index

Memory is supplemental implementation context, not canonical architecture. Read
only the sections relevant to the task. When memory conflicts with `replit.md`,
a canonical document, the schema, or the current API contract, trust the current
code/docs and update or archive the stale memory.

## Always applies

- [user_query widget doesn't render](interactive-prompts-dont-render.md) — this user can't see interactive prompts; ALWAYS ask clarifying questions in plain-text chat, never via user_query.

## Start here

- [`../../replit.md`](../../replit.md) — agent operating contract and stable invariants.
- [`../../docs/README.md`](../../docs/README.md) — documentation authority map and status vocabulary.
- [Memory maintenance policy](README.md) — what belongs here and how to retire it.
- [Canonical architecture map](architecture-canon.md) — authority hierarchy + entry points for non-trivial changes.

## Domain indexes

- [Money sync and reconciliation](money-sync-reconciliation.md) — QuickBooks, Stripe, Donorbox ingest, payment applications, settlement links, source links (live), workbench lessons. Read the canonical reconciliation docs before individual notes.
- [Email and calendar](email-calendar-sync.md) — Gmail/Calendar sync, open tracking, email intelligence, Flodesk, dedup.
- [CRM domain notes](crm-domain-notes.md) — gifts/pledges, donors/orgs/people, lists/dashboards, tasks/ingestion/admin feature lessons.
- [Platform and delivery notes](platform-and-delivery-notes.md) — build/env, API plumbing, prod-migration and data-operation gotchas.

## Core data-model invariants

- [opportunity status is calculated](wildflower-opp-status-calculated.md) — status fully derived server-side; only user override is loss_type (dormant/lost); never write status directly.
- [opp derivation idempotency](opp-derivation-idempotency.md) — deriveOppFields must be a true fixed point + SQL backfill mirrors it; cash_in is payment-driven; won pledge stage='complete' even if partially paid.
- [Donor XOR across split pickers](wildflower-donor-xor-pickers.md) — per-type donor pickers must send all 3 FK fields (null the rest) + allowNull=false to keep exactly-one invariant.
- [Gift must always have >=1 allocation](gift-allocation-seed-invariant.md) — all 6 mint paths seed a starter allocation via giftAllocationSeed.ts; grant_year set only if the fiscal_years FK row exists.
- [Allocation restriction model + total guard](wildflower-allocation-restriction-ux.md) — 3-axis restriction (any donor_restricted⇒restricted); coding→staged_payments, conditions→pledge_allocations; POST omits empties, PATCH sends null.
- [archive soft-delete boundaries](archive-soft-delete-boundaries.md) — archive REPLACED hard delete app-wide (only QuickBooks revert still hard-deletes); admin show-archived is server-enforced LIST-only; archived gifts EXCLUDED from analytics + pledge paid-amount.
- [Loan vs revenue tracks + loan_or_grant flag](loan-capital-fundraising-category.md) — loan_or_grant is the SOLE authority; gift `type` and fundraising_category columns are DROPPED (never revive); goals PK includes loan_or_grant.
- [Gift scope → allocation migration](gift-scope-allocation-migration.md) — settled/fees + off-books all DERIVED in giftPaymentSummary.ts (off-books = all allocs on no-payment entities); QB tie is live-derived, no stored column.

## Delivery, database, and verification

- [Scoped validation checks](scoped-validation-checks.md) — fast per-package + changed-scope checks; codegen CHECK is non-mutating (concurrency-safe), but the regen SCRIPT mutates — run it alone.
- [Dedicated vitest test DB](dedicated-test-db.md) — api-server vitest auto-provisions <devdb>_test (never dev); push only into an EMPTY recreated schema; mirrors entities/regions/fiscal_years.
- [Test-data hygiene](test-data-hygiene.md) — dev DB pollution patterns after killed runs: Test Dev/Admin e2e users, 2099-dated reconciliation seeds, dupspec phone constants.
- [Publish diffs the dev DB, not code](publish-diffs-dev-database.md) — stale dev DB → destructive reverts + skipped additive creates (→500); reconcile dev forward then re-publish; prod NEVER gets CREATE EXTENSION ([extensions](publish-flow-extensions.md)).
- [cross-env DB schema drift](cross-env-db-schema-drift.md) — successor task's dev DB lacks predecessor's new column; fix additively via SQL, never blunt push (drops unrelated drifted columns = data loss).
- [Data migration runs after Publish](data-migration-publish-ordering.md) — prod seed/backfill SQL dies "relation does not exist" unless Publish (schema diff) ran first; no BEGIN/COMMIT in a `psql -1` file.
- [Drizzle SQL pitfalls](drizzle-pitfalls.md) — 7 runtime-only footguns invisible to typecheck: ANY(array) cast, outer-paren syntax, top-level-field unqualify, ORDER BY ordinal, alias collision, alias ordering, .desc() index churn.
- [Orval / React Query patterns](orval-guide.md) — /api invalidation prefix; query options need queryKey; coerce.boolean "false"→true; array query params arrive comma-joined (normalizeArrayQuery).
- [api-server HTTP integration tests](api-server-http-integration-tests.md) — DB-backed route test pattern: mock requireAuth, boot app.listen(0)+fetch, raise hook timeouts, skipIf no real DB.

## Frontend and interaction conventions

- [Unpickable rows are labeled, never hidden](unpickable-rows-label-not-hide.md) — user rule (also in replit.md prefs): pickers gray blocked rows WITH the reason; enforce via 409s.
- [wildflower list-page chooser pattern](wildflower-list-chooser-pattern.md) — 4 list pages share filter/column choosers; saved views persist null at default, known/hidden keeps opt-in filters hidden for predating views.
- [List-page pagination & PageJumper](list-page-pagination.md) — pagination markup duplicated (not shared) across 6 list pages; blur-after-Enter/Escape needs skipBlurRef guard.
- [Select-in-Dialog scroll trap](select-in-dialog-scroll-trap.md) — a long shadcn Select nested in a modal Dialog overflows + can't scroll; use an inline scrollable RadioGroup instead.
- [Direct Playwright fallback](direct-playwright-fallback.md) — run committed e2e specs in small -g batches when runTest is down; full runs OOM; never pkill -f playwright (self-kill).
- [Testing subagent budget](testing-subagent-budget.md) — runTest is capped at 10 iterations/task and infra-timeouts count; one tiny flow per plan, check users table to detect a dead subagent.
- [Playwright e2e Clerk setup](playwright-e2e-clerk-setup.md) — 4 hard constraints to run committed e2e specs directly; the testing subagent bypasses all of them.
- [clerk admin-gated e2e testing](clerk-admin-e2e-testing.md) — testClerkAuth provisions team_member; add a [DB] step to promote to admin or admin cards silently 403/hide.

## High-risk operational notes

Use these only when the symptom matches:

- [Replit DB deletion nukes dev AND prod](replit-db-deletion-recovery.md) — deleting the built-in DB kills both branches; restore prod from dump human-run; verify with count(*) not n_live_tup.
- [Schema-rename reconciliation](lifecycle-rename-reconciliation.md) — clear a stuck post-merge RENAME via guarded manual pre-rename→push (never push-force); prove Publish safe by checking prod-only cols == rename sources.
- [post-merge push abort](post-merge-push-abort.md) — interactive drizzle-kit push aborts (skipping ALL additive changes) on schema-dropped columns still present in live DB; retain them as @deprecated, don't approve the drop.
- [Missing workspace symlink reads as TS2307](workspace-symlink-ts2307.md) — leaf typecheck "Cannot find module '@workspace/x'" = dropped pnpm symlink (run pnpm install); TS2305 is the stale-decl case.
- [prod executeSql enum cast](prod-executesql-enum-cast.md) — prod read returns ZERO rows (success=true) if the SELECT list has an un-cast enum column; always ::text enums.

## Historical context

- [Legacy reconciliation — pointer era](legacy-reconciliation/index.md) — regression context only; never current implementation guidance.
- `legacy/` and any future `archive/` directory — historical only.

## Search rule

When the relevant index does not answer the question, search filenames and
frontmatter descriptions (`grep -l` over `.agents/memory/`). Do not read all
memory files. A useful memory note states a durable rule, why it matters, its
current code/test anchor, and its retirement condition when transitional.
