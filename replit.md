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
node lib/db/src/import-airtable.mjs             # Re-import Airtable data (see below)
cd lib/db && pnpm exec tsc -p tsconfig.json     # Rebuild DB declarations (after schema changes)
```

**Important**: After changing the DB schema, always run both `pnpm --filter @workspace/db run push` AND `cd lib/db && pnpm exec tsc -p tsconfig.json` to keep declarations in sync.

## Database Schema (Airtable-aligned)

The schema in `lib/db/src/schema/` mirrors the Airtable "crm files" base. Every entity table has an `airtable_id` column (also used as the primary key `id`) so re-imports are idempotent and traceable.

**Core entities**:
- `regions` — geographic regions, self-referencing `parent_region_id`. Enum `region_type`: state, metro_area, city, neighborhood, region_within_state, multi_state_region, country, continent.
- `schools`, `households` — name-only lookups.
- `funders` — institutional + family funders. Self-referencing `parent_funder_id`. Array columns for `interests_thematic`, `interests_ages`, `interests_gov_models`.
- `organizations` — non-funder orgs (advisors, intermediaries, etc.). `city_region_id`/`state_region_id` reference `regions`.
- `payment_intermediaries` — DAFs, giving platforms. Enum `payment_intermediary_type`: daf, giving_platform.
- `people` — individuals (donors, advisors, staff contacts). Joined to entities via `people_entity_roles`.
- `people_entity_roles` — polymorphic join: a person plays a role in exactly one of funder / organization / payment_intermediary / household (enum `entity_role_type`). Enum `people_role_current`: current, past.
- `emails`, `phone_numbers`, `addresses` — contact info; FK to `people` (plus `funder_id`/`organization_id` for addresses). Enum `contact_current`: active, inactive.
- `opportunities_and_pledges` — both opportunities and pledges live in one table (matches Airtable). `status` enum: open, won, dormant, lost. `entity` + `grant_years` are arrays.
- `pledge_allocations` — line items within a pledge. Status enum: working, committed, superseded, committed_with_conditions.
- `gifts_and_payments` — gift records + payments against pledges. `payment_on_pledge_id` → opportunities_and_pledges.
- `gift_allocations` — line items within a gift.

**Regional designation junction tables** (many-to-many to `regions`):
- `funder_regional_priorities`
- `person_regional_priorities`
- `opportunity_regional_focus`
- `pledge_allocation_regional_designation`
- `gift_regional_designation`
- `gift_allocation_regional_designation`

**Other** (preserved from prior schema):
- `users` — Clerk-provisioned app users (kept for auth middleware).

### Imported record counts (current dev DB)

| Table | Rows |
|---|---|
| regions | 569 |
| schools | 117 |
| funders | 728 |
| organizations | 792 |
| payment_intermediaries | 35 |
| households | 75 |
| people | 3,201 |
| people_entity_roles | 2,331 (119 dropped for missing FK targets) |
| emails | 3,094 |
| phone_numbers | 1,203 |
| addresses | 1,676 |
| opportunities_and_pledges | 601 |
| pledge_allocations | 68 |
| gifts_and_payments | 691 |
| gift_allocations | 141 |
| junction tables | 1,503 total |

## Re-importing from Airtable

1. Use the Replit Airtable connector to fetch every record from the 15 tables of base `app8KUcmaHZ0AtcJZ` and write them as JSON to `/tmp/airtable-dump/<table>.json` (one file per table).
2. Run `node lib/db/src/import-airtable.mjs`. The importer:
   - Uses each Airtable record ID (`recXXXXXXXX`) as the Postgres primary key, so linked-record arrays in Airtable just work as foreign keys.
   - Inserts in dependency order; self-references (regions.parent, funders.parent) are filled in a second UPDATE pass.
   - Validates every FK against an in-memory set of inserted IDs and drops orphans rather than failing.
   - Uses `ON CONFLICT (id) DO NOTHING` so it's idempotent — running twice is safe.
   - Populates the 6 regional-designation junction tables last.

The legacy `pnpm --filter @workspace/db run seed` is a no-op stub; importing happens through the script above.

## Auth

Clerk middleware auto-provisions users on first sign-in (`requireAuth` middleware in API server). All API routes require authentication.

## Stage 2 — pending

Stage 1 (this work) rewrote the DB schema and seeded it from Airtable. Stage 2 still needs to be done:

- **OpenAPI spec** (`lib/api-spec/openapi.yaml`) — rewrite all paths and schemas to match the new tables, then regenerate hooks/zod via `pnpm --filter @workspace/api-spec run codegen`.
- **API server** (`artifacts/api-server/src/routes/`) — all routes except `health` are currently stubbed with a 503 "rebuilding" response. Rebuild routes against the new schema:
  - `/api/funders`, `/api/people`, `/api/organizations`, `/api/households`, `/api/payment-intermediaries`
  - `/api/opportunities-and-pledges`, `/api/pledge-allocations`
  - `/api/gifts-and-payments`, `/api/gift-allocations`
  - `/api/regions`, `/api/schools`
  - Dashboard / projections / grants-calendar — re-derive from the new tables.
- **Frontend** (`artifacts/wildflower-crm`) — the 17 pages were built against the old `individuals`/`pledges`/`gifts` schema. They need to be rewritten on top of the new schema and codegen output.
- **Zod schemas** (`lib/db/src/zod/`) — regenerate from new Drizzle schema if needed (current stubs may not compile).
