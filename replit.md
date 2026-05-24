# Wildflower Fundraising CRM

## Overview

Purpose-built fundraising CRM for Wildflower Schools, replacing Copper. Built as a pnpm workspace monorepo using TypeScript + React + Express + PostgreSQL.

**Current state**: The database schema has been wholesale-rewritten to mirror the Wildflower "crm files" Airtable base (`app8KUcmaHZ0AtcJZ`) and re-seeded with ~14,200 records imported directly from Airtable. The API and frontend have been rewritten on the new schema (see "Stage 2 — status" below). Remaining open items are noted there.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui (port from `PORT` env)
- **API framework**: Express 5 (port 8080)
- **Database**: PostgreSQL + Drizzle ORM
- **Auth**: Clerk (Google SSO restricted to @wildflowerschools.org)
- **Validation**: Zod, drizzle-zod
- **API codegen**: Orval (from OpenAPI spec → React Query hooks + Zod schemas)

## Architecture

```
lib/
  db/              — Drizzle schema, importer script, DB connection
  api-spec/        — OpenAPI spec (openapi.yaml) — source of truth
  api-client-react/ — Generated React Query hooks + response types
  api-zod/         — Generated Zod request/response validators
artifacts/
  api-server/      — Express REST API (port 8080)
  wildflower-crm/  — React frontend (Vite)
```

## Key Commands

```bash
pnpm run typecheck                              # Full typecheck all packages
pnpm --filter @workspace/api-spec run codegen   # Regenerate hooks/Zod from OpenAPI spec
pnpm --filter @workspace/db run push            # Push DB schema changes (dev only)
node lib/db/src/import-airtable.mjs             # Re-import Airtable data
cd lib/db && pnpm exec tsc -p tsconfig.json     # Rebuild DB declarations (after schema changes)
```

**Important**: After changing the DB schema, always run both `pnpm --filter @workspace/db run push` AND `cd lib/db && pnpm exec tsc -p tsconfig.json` to keep declarations in sync.

## Database

The schema lives in `lib/db/src/schema/` and mirrors the Airtable "crm files" base, with one tweak: `regions` uses human-readable slug PKs while every other entity uses the Airtable record ID directly as PK so re-imports stay idempotent. Donors on `opportunities_and_pledges` and `gifts_and_payments` are one of three mutually-exclusive options, DB-enforced via the `opportunities_and_pledges_donor_xor` / `gifts_and_payments_donor_xor` CHECK constraints: `funder_id` (organizational), `individual_giver_person_id` (single person), or `household_id` (joint account). The API server pre-validates the same invariant in opps + gifts POST/PATCH handlers via `validateOppInvariants` / `validateGiftInvariants` in `@workspace/api-zod`, so the API returns 400 instead of letting the DB raise a 500. Many-to-many links use `text[]` slug arrays with GIN indexes — query with array operators (`@>`, `&&`, `<@`), never `= ANY(...)`.

Full per-table schema reference, primary-contact rules, intended-usage rules, slug-array query patterns, record counts, and the Airtable importer workflow are documented in [`lib/db/SCHEMA.md`](lib/db/SCHEMA.md).

## Auth

Clerk middleware auto-provisions users on first sign-in (`requireAuth` middleware in API server). All API routes require authentication.

## Stage 2 — status

Stage 1 rewrote the DB schema and seeded it from Airtable. Stage 2 has now landed:

- **OpenAPI spec** (`lib/api-spec/openapi.yaml`) — mirrors the new tables. Includes the analytics tag (`/dashboard-summary`, `/projections-by-fy-entity`). Regenerate hooks/zod after edits via `pnpm --filter @workspace/api-spec run codegen`.
- **API server** (`artifacts/api-server/src/routes/`) — all CRUD routes for the new tables are implemented (funders, people, organizations, households, payment-intermediaries, opportunities-and-pledges, pledge-allocations, gifts-and-payments, gift-allocations, regions, schools, etc.) plus the two new analytics endpoints in `routes/analytics.ts`. Dashboard / projections / grants-calendar are now derived server-side from the new tables.
- **Frontend** (`artifacts/wildflower-crm`) — all 17 pages are on the new schema and the generated hooks (`useListPeople`, `useListFunders`, `useListHouseholds`, `useListOpportunitiesAndPledges`, `useListGiftsAndPayments`, etc.). `/pledges` + `/pledges/:id` re-use the opportunities views (pledges are a status-filtered slice of opportunities-and-pledges in the new model). Donor xor (`funderId` / `individualGiverPersonId` / `householdId`) is wired through opportunity-detail and gift-detail.
- **Zod schemas** — there is no `lib/db/src/zod/` package and nothing imports one. Server-side validation lives in `@workspace/api-zod`, regenerated from the OpenAPI spec by orval. `drizzle-zod` remains in `lib/db/package.json` for opportunistic per-route use but is not the chosen request-validation path.
- **API contract gaps** (resolved 2026-05-23): `household_id` is now in opps + gifts (response + Create/Update bodies + list filters), `historical_names` (text[]) in funders + organizations (response + Create/Update bodies), `private_wealth_manager` added to `PaymentIntermediaryType` enum. Request-level invariant validation for the `donor_xor` and `closed_requires_completion_date` CHECK constraints is wired into the opps + gifts POST/PATCH handlers via shared `validateOppInvariants` / `validateGiftInvariants` helpers in `@workspace/api-zod` — PATCH validates merged post-update state so partial updates can't bypass the check. API returns 400 instead of 500 on invariant violations.

### Known follow-ups (non-blocking)

- **FY boundary uses UTC.** `currentFiscalYear` in `/dashboard-summary` is computed from `getUTCMonth/getUTCFullYear`. Around midnight on Jun 30 / Jul 1 it can flip up to a day early/late depending on the org's local timezone. Worth pinning to America/Chicago (or whichever timezone Wildflower books in) before next fiscal year-end.
- **Tests.** No automated API or component tests yet for the new analytics endpoints or for the donor-xor invariants. Worth adding a small fixture suite before further schema churn.
