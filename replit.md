# Wildflower Fundraising CRM

## Overview

Purpose-built fundraising CRM for Wildflower Schools, replacing Copper. A pnpm
workspace monorepo: TypeScript + React/Vite + Express 5 + PostgreSQL/Drizzle,
auth via Clerk. The schema mirrors the Wildflower "crm files" Airtable base
(`app8KUcmaHZ0AtcJZ`), seeded with ~14,200 imported records. The `funders` and
`organizations` tables are **consolidated** into one `organizations` table (an
`issuesGrants` flag distinguishes grant-makers).

The product goal: give the fundraising team one trustworthy place to run the whole
donor lifecycle — pipeline → commitments → cash in — with money, communications
(Gmail/Calendar), and accounting (QuickBooks/Stripe) all reconciled against the same
donor records, replacing a hand-stitched mix of Copper, spreadsheets, and inboxes.

## Change recipe map

For the common edits (add a field end-to-end, add a list filter/column, add an
API endpoint, ship a prod migration, change a derived field, change a validation
rule), [`docs/change-recipes.md`](docs/change-recipes.md) gives the exact entry
files, ordered steps, invariants at risk, and which fast check to run — start
there before re-tracing a routine change.

## Design principles (the invariants to protect)

These recur across the whole app — keep them true whenever you change things:

1. **Contract-first.** `lib/api-spec/openapi.yaml` is the source of truth; the React
   Query hooks (`api-client-react`) and Zod validators (`api-zod`) are *generated*
   from it. Change the spec, regenerate, then implement — never hand-edit generated
   files.
2. **Money model = header + allocations.** `opportunities_and_pledges` and
   `gifts_and_payments` are header-only; ALL scope (entity, fiscal year, region,
   intended usage, sub-amounts, revenue coding) lives on the child allocation rows.
3. **Opportunity status is calculated, never written by hand** — derived from stage +
   payments + the user-set `loss_type` override. The only user-settable lifecycle
   input is `loss_type` (`dormant` / `lost`).
4. **Donor XOR.** Every opportunity and gift has exactly one donor (organization,
   individual, or household), enforced at the DB (CHECK), the API, and on merged
   PATCH state. Staged payment/charge queue rows hold *at most one* candidate donor;
   exactly-one is enforced only when they approve/reconcile into a gift
   (`validateGiftInvariants`).
5. **Revenue and loan capital are parallel tracks.** Never fold `loan_capital` into
   revenue rollups; goals and analytics split by `fundraising_category`.
6. **Archive, don't delete.** Soft-delete (`archived_at`) is the app-wide default;
   only a few explicit paths still hard-delete.
7. **Non-destructive, human-applied prod data changes.** The agent cannot write to
   prod. Schema/code ship via Publish; every prod *data* change is a reviewed,
   idempotent SQL file in `lib/db/migrations/`, applied by a human.

## User preferences

- Prefers non-destructive, staged migrations and explicit confirmation before any
  destructive or production-facing change.
- Precise and hands-on; wants to understand tradeoffs and consequences before acting.
- When giving prod data-migration `psql` commands to run by hand, always use the
  `$PROD_DATABASE_URL` variable (NOT `$DATABASE_URL`) and the full repo-root-relative
  path to the `.sql` file (e.g. `lib/db/migrations/<file>.sql`), so they can be
  copy-pasted and run from the project root.

## Stack

- **Monorepo**: pnpm workspaces · **Node**: 24 · **TypeScript**: 5.9
- **Frontend**: React + Vite + Tailwind + shadcn/ui (port from `PORT` env)
- **API**: Express 5 (port 8080)
- **Database**: PostgreSQL + Drizzle ORM
- **Auth**: Clerk (Google SSO restricted to @wildflowerschools.org)
- **Validation**: Zod / `@workspace/api-zod` (generated from the OpenAPI spec)
- **API codegen**: Orval (OpenAPI spec → React Query hooks + Zod schemas)

## Architecture

```
lib/
  db/                        — Drizzle schema, DB connection
  api-spec/                  — OpenAPI spec (openapi.yaml) — contract source of truth
  api-client-react/          — Generated React Query hooks + response types
  api-zod/                   — Generated Zod validators + Donor-XOR invariant guards
  integrations-anthropic-ai/ — Anthropic SDK wrapper (batching, retries, rate-limit)
  object-storage-web/        — React hooks + Uppy components for GCS uploads
artifacts/
  api-server/                — Express REST API (port 8080)
  wildflower-crm/            — React frontend (Vite)
  mockup-sandbox/            — design/prototyping preview server (not deployed)
scripts/                     — maintenance scripts (@workspace/scripts)
tools/
  magio-extension/           — Gmail open-tracking browser extension (NOT in the workspace)
```

## Key Commands

```bash
pnpm run typecheck                                       # Full typecheck (builds libs first)
pnpm --filter @workspace/api-spec run codegen           # Regenerate hooks/Zod from spec (orval + barrel)
pnpm --filter @workspace/api-spec run codegen:check      # codegen + verify generated code compiles
pnpm --filter @workspace/db run push                    # Push DB schema changes (dev only)
cd lib/db && pnpm exec tsc -p tsconfig.json             # Rebuild DB declarations after schema changes
pnpm --filter @workspace/api-server run test            # API server vitest
pnpm --filter @workspace/scripts run cleanup:test-users # Archive test users after e2e runs
```

**After a schema change**, run both `pnpm --filter @workspace/db run push` AND
`cd lib/db && pnpm exec tsc -p tsconfig.json` so the composite-lib declarations
stay in sync (stale declarations show up as "property does not exist" on the leaf
typecheck — trust `pnpm run typecheck`, which builds libs first).

### Fast scoped checks (verify just what you touched)

Prefer these over a full rebuild — each is scoped as tightly as possible, so after
the first warm build later runs finish in seconds. They are registered as named
validation checks (run on demand, each returns a pass/fail summary + log path) and
also exist as root `check:*` scripts for a plain shell:

| Check      | Root script          | What it does                                            |
|------------|----------------------|---------------------------------------------------------|
| `libs`     | `pnpm check:libs`    | Build the shared libs (run before leaf checks)          |
| `api`      | `pnpm check:api`     | Typecheck only the API server                           |
| `web`      | `pnpm check:web`     | Typecheck only the CRM frontend                         |
| `codegen`  | `pnpm check:codegen` | Regenerate hooks/Zod from the spec + verify they compile |
| `test-api` | `pnpm check:test-api`| Run only the API server tests                           |
| `test-web` | `pnpm check:test-web`| Run only the frontend tests                             |
| `full`     | `pnpm check:full`    | The complete `pnpm run typecheck` (unchanged safety net)|

**Which check after which change:**

- Edited `lib/api-spec/openapi.yaml` (the contract) → run `codegen`.
- Edited API server code → run `api` (+ `test-api` if logic changed).
- Edited CRM frontend code → run `web` (+ `test-web` if logic changed).
- A leaf check reports missing `@workspace/*` types → run `libs` first, then re-run
  the leaf check (stale lib declarations, not a real error).
- Before finishing / when unsure → run `full`.

The first run of a check warms the incremental cache (slow); subsequent runs are fast.

## Database

Schema lives in `lib/db/src/schema/`. Every entity uses its Airtable record ID as
the PK so re-imports stay idempotent (exceptions: `regions`, `entities`,
`fundable_projects`, and `fiscal_years` use human-readable slug PKs). Full per-table
reference is in [`lib/db/SCHEMA.md`](lib/db/SCHEMA.md).

Key invariants:

- **Donor XOR** — `opportunities_and_pledges` and `gifts_and_payments` each have
  exactly one donor: `organization_id`, `individual_giver_person_id`, or
  `household_id`. Enforced by DB CHECK constraints *and* pre-validated in the API
  (`validateOppInvariants` / `validateGiftInvariants` in `@workspace/api-zod`) so
  the API returns 400 instead of a DB 500. PATCH validates merged post-update state.
- **Many-to-many links** use `text[]` slug arrays with GIN indexes — query with
  array operators (`@>`, `&&`, `<@`), never `= ANY(...)`.

## Auth

Clerk middleware (`requireAuth`) auto-provisions users on first sign-in; all API
routes require auth.

**E2E testing note (Clerk captcha):** use the testing skill's `runTest` with
`testClerkAuth: true` and an `@wildflowerschools.org` email for a programmatic,
already-authenticated session — never drive the Clerk sign-in UI or captcha;
navigate straight to the target path. Treat a mid-run captcha as noise (retry).

## Features

Each line is a pointer; deep implementation detail lives in the code, the schema
reference, and the design docs.

- **CRM core** — organizations (grant-makers flagged via `issuesGrants`), people,
  households, opportunities & pledges, gifts & payments, allocations, payment
  intermediaries, regions, schools, fiscal years. Dashboard / projections /
  grants-calendar analytics are derived server-side.
- **Opportunity lifecycle** — `status` (`open`/`pledge`/`cash_in`/`dormant`/`lost`)
  is fully derived (invariant #3). Precedence: `loss_type` > `cash_in`
  (payment-driven) > `pledge` (sticky `written_pledge`/`was_pledge` flag) > `open`.
  The sticky flag auto-latches true only when an *unpaid* grant letter exists; a
  fully-paid grant or merely-described money is NOT a pledge. Grant-letter upload
  via object storage (presigned GCS URL).
- **Fundraising categories (revenue vs loan capital)** — parallel analytics tracks
  (invariant #5): `fundraising_category` enum, per-category goals, dashboard renders
  a track per fiscal year. All pre-existing data is `revenue`.
- **List-page choosers** — per-page filter + column choosers on the 4 list pages,
  persisted in saved views.
- **Media-mention ingestion** — daily off-hours GDELT DOC 2.0 pull (free, no key)
  for high-capacity funders/people; DB-atomic dedupe, no AI summary by design.
- **Email open tracking** — per-recipient open attribution ("Path A") via a
  per-recipient pixel-tagged Gmail send, driven by the `tools/magio-extension`
  browser extension (per-user extension token); falls back to a single pixel.
- **Anonymous records** — `anonymous` flag masks org/person names in the UI to
  "Anonymous" for everyone but the owner and admins. UI-only (names stay in API
  responses); some join-projection name refs aren't masked yet.
- **QuickBooks payment sync** — pull-only QBO → CRM. Scheduled + on-demand worker
  stages incoming money in a review queue ("Finance Reconciliation") keyed
  idempotently by `(realmId, qbEntityType, qbEntityId, qbLineId)`, auto-matches
  donors, and attributes an `entity_id` from text markers. Approve mints a gift in a
  tx (Donor XOR). Tokens encrypted at rest; never writes back to QB.
- **Gift ↔ QuickBooks tie status** — every gift carries a derived-but-persisted
  `quickbooks_tie_status` (`exempt`/`tied`/`amount_mismatch`/`missing`), recomputed
  at every link/amount mutation (`applyGiftQbTieMany`) + a backfill script. Off-books
  gifts are exempt. Gifts list has a `quickbooksTie` filter; a per-gift
  audit-reconciliation read view returns the when/where/who/restrictions trail.
- **Flodesk subscriber sync** — people → one segment. Outbound upserts eligible
  people fire-and-forget on create/update; inbound reconcile is daily + monotonic
  (only ever SETS unsubscribed). Flodesk unsubscribe always wins. No-op until
  `FLODESK_API_KEY` + `FLODESK_SEGMENT_ID` are set.
- **Stripe sync + reconciliation** — a second pull-only money source parallel to
  QuickBooks; the reconciliation queue ties a coarse QB deposit/payout lump to its
  individual Stripe charges so money is never booked twice. The ratified target
  state (two planes, one unit↔gift ledger + one settlement-link table, derived
  statuses, phased prod-safe path) is in
  [`docs/reconciliation-design.md`](docs/reconciliation-design.md) — treat that doc
  as the source of truth for the in-flight reconciliation redesign.
- **Allocation restriction (three axes)** — restriction captured per allocation on
  `regional`/`usage`/`time` axes (each `donor_restricted`/`wf_restricted`/
  `unrestricted`); a line codes restricted when ANY axis is `donor_restricted`.
- **Revenue-accounting coding (CFO "Revenue Extractor")** — coding is derived on
  demand from allocation scope (`revenueCoding.ts`) with per-fund-entity overrides;
  no longer persisted on allocations (editors show a live preview, the reviewer
  snapshots it onto the matching `staged_payments` row).
- **Grant conditions** — `conditional` + `conditions_met` on `pledge_allocations`;
  the opportunity header exposes a derived rollup that drives win-probability
  weighting (conditional written pledge weights 0.75 vs 0.90).
- **Email & calendar sync + intelligence** — per-user Gmail/Calendar sync matched to
  CRM entities; AI "email intelligence" (Claude) extracts signals into
  `email_proposals` a reviewer accepts/rejects (versioned, admin-tunable prompt).
  Grant opportunities also feed a team-shared `grant_leads` queue.
- **Tasks + AI next-step suggestions** — manual + reporting-deadline tasks with
  AI-proposed next steps, auto-generated only on true first view.
- **Entity merge** — transactional collapse of duplicate orgs/people into a primary
  (re-points every FK, merges arrays, archives the duplicate). A FK-inventory test
  fails on schema drift so a new FK can't be silently missed.
- **Meeting notes** — paste-a-transcript flow → editable AI summary + action items
  in the activity timeline.
- **Archive (soft-delete)** — app-wide default; archived rows leave list views
  (admin-only "show archived", LIST only) and archived gifts are excluded from
  financial / pledge-paid totals. A few hard-delete exceptions remain (gift merge,
  QuickBooks revert).

## Known follow-ups (non-blocking)

- **Prod data changes** — prod holds live data; the agent cannot write to it.
  Schema/code ship via Publish; every prod data change is a reviewed idempotent SQL
  file (see `lib/db/migrations/` + runbooks), applied by a human with
  `psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/<file>.sql`.
- **`gmail.send` scope** — new OAuth scope; each user must reconnect Google once.
  Until then the extension falls back to the legacy single-pixel send.
- **Anonymous masking gaps** — join-projection name references (role rows, household
  members, colleague/affiliation lists) aren't masked yet. Gift NAMES (which often
  embed donor names) are also returned unmasked everywhere, including the
  gifts-missing-qb `linkedMatches` companion list.
- **Media ingest** — no relevance filtering on person-name searches (common names →
  false positives); live GDELT calls are flaky from the dev sandbox but work in prod.
