# Wildflower Fundraising CRM

## Overview

Purpose-built fundraising CRM for Wildflower Schools, replacing Copper. Built as a pnpm workspace monorepo using TypeScript + React + Express + PostgreSQL.

**Current state**: The database schema has been wholesale-rewritten to mirror the Wildflower "crm files" Airtable base (`app8KUcmaHZ0AtcJZ`) and re-seeded with ~14,200 records imported directly from Airtable. The API and frontend are awaiting Stage 2 rewrite (see "Stage 2 — pending" below).

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

The schema lives in `lib/db/src/schema/` and mirrors the Airtable "crm files" base, with one tweak: `regions` uses human-readable slug PKs while every other entity uses the Airtable record ID directly as PK so re-imports stay idempotent. Donors on `opportunities_and_pledges` and `gifts_and_payments` are one of three mutually-exclusive options (convention, not DB-enforced): `funder_id` (organizational), `individual_giver_person_id` (single person), or `household_id` (joint account). Many-to-many links use `text[]` slug arrays with GIN indexes — query with array operators (`@>`, `&&`, `<@`), never `= ANY(...)`.

Full per-table schema reference, primary-contact rules, intended-usage rules, slug-array query patterns, record counts, and the Airtable importer workflow are documented in [`lib/db/SCHEMA.md`](lib/db/SCHEMA.md).

## Auth

Clerk middleware auto-provisions users on first sign-in (`requireAuth` middleware in API server). All API routes require authentication.

## Stage 2 — pending

Stage 1 (this work) rewrote the DB schema and seeded it from Airtable. Stage 2 still needs to be done:

- **OpenAPI spec** (`lib/api-spec/openapi.yaml`) — rewrite all paths and schemas to match the new tables, then regenerate hooks/zod via `pnpm --filter @workspace/api-spec run codegen`.
- **API server** (`artifacts/api-server/src/routes/`) — core CRUD routes for the new tables are implemented (funders, people, organizations, households, payment-intermediaries, opportunities-and-pledges, pledge-allocations, gifts-and-payments, gift-allocations, regions, schools, etc.). Still missing: dashboard / projections / grants-calendar — re-derive from the new tables.
- **Frontend** (`artifacts/wildflower-crm`) — the 17 pages were built against the old `individuals`/`pledges`/`gifts` schema. They need to be rewritten on top of the new schema and codegen output.
- **Zod schemas** (`lib/db/src/zod/`) — regenerate from new Drizzle schema if needed (current stubs may not compile).
- **API contract gaps** — recent schema additions are not yet reflected in `lib/api-spec/openapi.yaml` or downstream codegen: `household_id` on opps + gifts, `historical_names` on funders + organizations, the new `private_wealth_manager` payment-intermediary-type value, the strict `donor_xor` CHECK constraint, and request-level validation for the donor XOR rule. Add these when you rewrite the spec.
