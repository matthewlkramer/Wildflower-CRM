# Wildflower Fundraising CRM

## Overview

Purpose-built fundraising CRM for Wildflower Schools, replacing Copper. A pnpm
workspace monorepo: TypeScript + React/Vite + Express 5 + PostgreSQL/Drizzle,
auth via Clerk.

The database schema mirrors the Wildflower "crm files" Airtable base
(`app8KUcmaHZ0AtcJZ`) and was seeded with ~14,200 records imported from Airtable.
The `funders` and `organizations` tables have been **consolidated** into a single
`organizations` table (an `issuesGrants` flag distinguishes grant-makers).

## User preferences

- Prefers non-destructive, staged migrations and explicit confirmation before any
  destructive or production-facing change.
- Precise and hands-on; wants to understand tradeoffs and consequences before acting.

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
  db/               — Drizzle schema, importer script, DB connection
  api-spec/         — OpenAPI spec (openapi.yaml) — contract source of truth
  api-client-react/ — Generated React Query hooks + response types
  api-zod/          — Generated Zod request/response validators
artifacts/
  api-server/       — Express REST API (port 8080)
  wildflower-crm/   — React frontend (Vite)
tools/
  magio-extension/  — Gmail open-tracking browser extension (NOT in the workspace)
```

## Key Commands

```bash
pnpm run typecheck                                       # Full typecheck (builds libs first)
pnpm --filter @workspace/api-spec run codegen           # Regenerate hooks/Zod from OpenAPI spec
pnpm --filter @workspace/db run push                    # Push DB schema changes (dev only)
cd lib/db && pnpm exec tsc -p tsconfig.json             # Rebuild DB declarations after schema changes
pnpm --filter @workspace/api-server run test            # API server vitest
node lib/db/src/import-airtable.mjs                      # Re-import Airtable data (see follow-ups — stale)
pnpm --filter @workspace/scripts run cleanup:test-users # Archive test users after e2e runs
```

**After a schema change**, run both `pnpm --filter @workspace/db run push` AND
`cd lib/db && pnpm exec tsc -p tsconfig.json` so the composite-lib declarations
stay in sync (stale declarations show up as "property does not exist" on the leaf
typecheck — trust `pnpm run typecheck`, which builds libs first).

## Database

Schema lives in `lib/db/src/schema/`. Every entity uses its Airtable record ID as
the PK so re-imports stay idempotent (exception: `regions` uses human-readable slug
PKs). Full per-table reference is in [`lib/db/SCHEMA.md`](lib/db/SCHEMA.md).

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
`testClerkAuth: true` and an `@wildflowerschools.org` email to get a programmatic
session. The session is already authenticated — never drive the Clerk sign-in UI
or captcha; navigate straight to the target path. Treat any captcha that appears
mid-run as noise (retry), not a blocker.

## Features

- **CRM core** — organizations (grant-makers flagged via `issuesGrants`), people,
  households, opportunities & pledges, gifts & payments, allocations, payment
  intermediaries, regions, schools, fiscal years. Pledges are a status-filtered
  slice of opportunities. Dashboard / projections / grants-calendar analytics are
  derived server-side.
- **Opportunity derivation** — pledge-stage / derived fields computed by a pure
  `deriveOppFields` + a DB-touching `applyDerivedOppFields` wrapper (backfill
  script available). Grant-letter upload via object storage (presigned GCS URL).
- **List-page choosers** — per-page filter + column choosers on the 4 list pages
  (individuals, organizations, opportunities, gifts), persisted in saved views.
- **Media-mention ingestion** — daily off-hours (America/Chicago) scheduled job
  pulls press coverage from GDELT DOC 2.0 (free, no API key) for high-capacity
  funders/people. DB-atomic dedupe; no AI summary by design. Manual trigger:
  `pnpm --filter @workspace/api-server run ingest:media`.
- **Email open tracking** — per-recipient open attribution ("Path A"): for
  multi-recipient, attachment-free sends the server sends one pixel-tagged copy
  per recipient via the Gmail API; everything else falls back to a single-pixel
  send. Driven by the `tools/magio-extension` browser extension authenticated with
  a per-user extension token (Settings → Email tracking extension).
- **Anonymous records** — `anonymous` flag on organizations + people masks the
  name in the UI to "Anonymous" for everyone except the record owner and admins.
  UI-only by design (names are still in API responses).
- **QuickBooks payment sync** — one-way QuickBooks Online → CRM pull. An admin
  connects QuickBooks once via Intuit OAuth (Settings → QuickBooks). A scheduled
  (30-min) + on-demand worker pulls incoming money (SalesReceipt / Payment /
  Deposit) since a per-connection watermark, auto-matches CRM donors by name/email,
  and stages rows in a review queue (`/staged-payments`, "QuickBooks Review" nav).
  A fundraiser fixes the donor match and approves/rejects; approve mints a
  `gifts_and_payments` row in a tx (Donor XOR via `validateGiftInvariants`).
  Idempotent by `(realmId, qbEntityType, qbEntityId)`; staged rows retained after
  approve/reject for dedupe. Tokens + realmId encrypted at rest; OAuth/token
  endpoints are env-shared, the data host is env-derived (`QUICKBOOKS_API_BASE`,
  defaults to the production Intuit host). Pull-only — never writes back to QB.

## Known follow-ups (non-blocking)

- **Production data changes** — prod now holds **live data**, so the old "overwrite
  data" cutover (replace prod wholesale with dev's) is no longer safe. The agent
  cannot write to prod. Schema/code changes ship via the normal Publish flow;
  every prod **data** change must be delivered as a reviewed, idempotent SQL file
  (see `lib/db/migrations/` + its runbooks) and applied by a human with
  `psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <file>.sql`.
- **Stale importer/docs** — `lib/db/src/import-airtable.mjs` and `lib/db/SCHEMA.md`
  still target the OLD split funders/organizations model; update them before any
  re-import (a re-import will otherwise fail).
- **FY boundary uses UTC** — `currentFiscalYear` in `/dashboard-summary` is UTC-based;
  pin to America/Chicago before fiscal year-end to avoid an off-by-a-day flip.
- **`gmail.send` scope** — new OAuth scope; each user must reconnect Google once.
  Until then the extension cleanly falls back to the legacy single-pixel send.
- **Anonymous masking gaps** — join-projection name references (role rows, household
  members, colleague/affiliation lists) aren't masked yet; needs `anonymous` +
  `ownerUserId` added to those endpoint projections.
- **Media ingest** — no relevance filtering on person-name searches (common names
  → false positives); live GDELT calls are flaky from the dev sandbox but work in
  the deployed env.
