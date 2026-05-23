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

The schema in `lib/db/src/schema/` mirrors the Airtable "crm files" base. Every entity table uses the Airtable record ID (`recXXXXXXXX`) directly as its `id` primary key so re-imports are idempotent and linked-record arrays from Airtable work as foreign keys without translation. The only exception is `regions`, whose PK is a human-readable slug (see the regions entry below). A separate `airtable_id` column was removed as redundant; rows synthesized by the importer (`pi-email-<piId>`, `org-addr-<orgId>`) are still distinguishable from imported rows by the `id LIKE 'rec%'` predicate.

**Core entities**:
- `regions` — geographic regions, self-referencing `parent_region_id`. Enum `region_type`: state, metro_area, city, neighborhood, region_within_state, multi_state_region, country, continent. **PK is a human-readable slug** (e.g. `united_states__minnesota__saint_paul`), not the Airtable record ID. The slug is built from the region's own name plus the names of its ancestors of the "included" types (`continent` / `country` / `state` / `city` / `neighborhood`); intermediate aggregation layers (`multi_state_region`, `region_within_state`, `metro_area`, untyped) appear only as the last segment of their own slug and are skipped when building descendants' slugs, so inserting or removing e.g. a "Great Lakes Region" wrapper between `united_states` and `minnesota` never disturbs the state or its cities. `display_path` is a denormalized comma-separated full path including every ancestor (e.g. `United States, New England, Massachusetts, Greater Boston, Boston`), populated by the importer for cheap UI display.
- `schools` — mirrored one-way from the dedicated Wildflower **Schools** Airtable base (`appJBT9a4f3b7hWQ2`), specifically the "Data for CRM in Replit" view. Re-sync with `AIRTABLE_TOKEN=... node lib/db/src/sync-schools-from-airtable.mjs` (the script wipes and reloads the table; uses Airtable record IDs as PKs). Columns mirrored: `name`, `long_name`, `short_name`, `status` (enum `school_status`: `emerging` / `open` / `paused` / `closing` / `permanently_closed` / `disaffiliating` / `disaffiliated` / `placeholder` / `abandoned`), `governance_model` (enum: `independent` / `district` / `charter` / `exploring_charter` / `community_partnership`), `ages_planes` (text[] of Airtable record IDs from the linked Ages-Planes table — not imported as its own table yet), `logo_main_square_url`, `stage_status` (Airtable formula; denormalized for convenience), `current_mailing_address` and `current_physical_address` (denormalized lookups from the Locations table, joined with `\n\n` when multi-valued). The schools base lives in a different Airtable base than the "crm files" base used by the other importer, so the dedicated-base record IDs replace the old crm-files-base IDs — no other tables currently FK to schools.
- `households` — name + `active` boolean (defaults true; set false when a household is dissolved by death or divorce).
- `funders` — institutional + family funders. Self-referencing `parent_funder_id`. Array columns for `interests_thematic`, `interests_ages`, `interests_gov_models`. Includes optional `org_email`. Enum columns: `funding_entity_subtype` (18 values like `family_foundation`, `corporate_foundation`, `government`, etc.), `number_of_employees` (size buckets `e_1` / `e_2_10` / `e_11_50` / `e_51_250` / `e_251_1000` / `e_1001_10000` / `e_10000_plus`), `capacity_rating` (`tier_10k_50k` … `tier_1m_plus`), `connection_status` (`connected` / `have_a_connector` / `no_connection`), `enthusiasm` (`advocate` / `supportive` / `warm` / `neutral` / `unsupportive`), `strategic_alignment` (`high` / `medium` / `low`), `active_status` (`active` / `defunct` / `spenddown`).
- `organizations` — non-funder orgs (advisors, intermediaries, etc.). All address fields live in the `addresses` table (FK `organization_id`); the importer creates a synthetic `org-addr-<orgId>` address row per org with any address data. `owner` is legacy Copper text; `owner_user_id` is the FK to `users` that supersedes it. `type` is an enum with 20 values (`advocacy_membership_lobbyist`, `authorizer`, `cmo`, `capital_provider`, `government`, `corporation`, `education_vendor`, `elected_official`, `higher_ed`, `investor`, `law_firm`, `media`, `nonprofit`, `philanthropic_advisor`, `real_estate`, `school`, `school_district`, `school_network`, `small_business_consulting`, `tribal`).
- `payment_intermediaries` — DAFs, giving platforms. Enum `payment_intermediary_type`: daf, giving_platform.
- `people` — individuals (donors, advisors, staff contacts). Joined to entities via `people_entity_roles`.
- `people_entity_roles` — polymorphic join: a person plays a role in exactly one of funder / organization / payment_intermediary / household (enum `entity_role_type`). `connection` enum (`employee` / `principal` / `board_member` / `partner` / `professor` / `donor_advisor` / `elected_official`) and `people_role_current` (`current` / `past`).
- `emails`, `phone_numbers`, `addresses` — contact info. Each row carries optional FKs `person_id`, `funder_id`, `organization_id`, `payment_intermediary_id`, `household_id` (exactly one is typically set). Each contact row has `validity` (`valid` / `invalid` / `unknown`) and `is_preferred` boolean. `emails.type` uses `email_type` enum (`work` / `personal` / `other`); `phone_numbers.type` uses `phone_type` (`work` / `mobile` / `home` / `other`). `addresses` also carries denormalized `city_name` and `state_code` populated by the importer from the linked region.
- `entities` — fund entities (Wildflower Foundation, Black Wildflowers Fund, Sunlight - debt, Sunlight - grants, Sunlight - equity, Observation Support Technologies / Observant Education, Tierra Indigena, Embracing Equity, Rising Tide). Slug-style PK so new entities can be added through the UI without a migration. Opportunities use `opportunities_and_pledges.entity_ids` (text[] of entity slugs) for multi-entity attribution; `gifts_and_payments.entity_id`, `pledge_allocations.entity_id`, and `gift_allocations.entity_id` are single FKs.
- `fundable_projects` — specific projects a contribution can fund (seeded: `mdd`, `ssj`, `charter_growth`, `tsl`, `observation_support_tech`). Slug PK. Referenced by `opportunities_and_pledges.fundable_project_ids` (text[]), `pledge_allocations.fundable_project_id`, `gifts_and_payments.fundable_project_id`, and `gift_allocations.fundable_project_id` whenever the row's `intended_usage` (or `intended_usages` entry on opportunities) is `'project'`.
- `fiscal_years` — reference table for Wildflower's July 1 – June 30 fiscal years. Slug PK (e.g. `fy2024`), seeded from `fy2014` through `fy2050`, plus a `future` sentinel. Used by `opportunities_and_pledges.grant_years` (text[] of slugs — multi-year grants span a range at the opportunity level) and by `pledge_allocations.grant_year`, `gifts_and_payments.grant_year`, and `gift_allocations.grant_year` (single text FK each — one fiscal year per per-row money booking; multi-year commitments are split across multiple allocation rows).
- `opportunities_and_pledges` — both opportunities and pledges live in one table. `status` (`open` / `won` / `dormant` / `lost`), `type` (`solicitation` / `renewal` / `open_application`), `stage` (9 values: `cold_lead` … `cash_in`), and `conditional` (`unconditional` / `reimbursable` / `conditional_on_funder_determination` / `conditional_on_target`) are all enums. `grant_years` is a text[] of `fiscal_years.id` slugs. `entity_ids` text[], `intended_usages` enum[], and `fundable_project_ids` text[] are all multi-valued — these three are **independent unordered sets**, not positionally aligned tuples. They represent the rough-draft scope of an opportunity during early donor conversations (e.g. "talking to this donor about possibly funding {Wildflower Foundation, Black Wildflowers Fund} for {gen_ops, project} purposes, where the 'project' might be {ssj}"). Once a conversation firms up and amounts are committed, structured per-row line items get written to `pledge_allocations` (and at payment time, `gift_allocations`); the opportunity-level arrays intentionally stay fuzzy. `match_id` is a self-referential FK on the matching-gift row pointing to the original opportunity it matches. `owner` is legacy Copper text; `owner_user_id` is the FK to `users` that supersedes it. `copper_pledge_id` preserves the Copper-era external pledge ID for cross-reference.
- `pledge_allocations` — line items within a pledge. Status enum: working, committed, superseded, committed_with_conditions.
- `gifts_and_payments` — gift records + payments against pledges. `payment_on_pledge_id` → opportunities_and_pledges. Enums: `type` (`standard_gift` / `pledge_payment` / `directed_gift` / `loan_fund_investment` / `matching_gift`), `payment_method` (`ach` / `check` / `wire` / `stock` / `donor_box` / `daf_ach` / `daf_check` / `daf_bill_com`), `allocation_type` (`simple_allocation` / `sub_allocations`). `entity_id` FK → `entities`. `date_received` is the canonical "money arrived" date for new writes. `close_date` and `completed_date` are legacy Copper-era columns with haphazard, unreliable semantics — preserved as-is for historical reference, slated for a future back-fill-and-drop pass.

**Intended usage** — `opportunities_and_pledges`, `pledge_allocations`, `gifts_and_payments`, and `gift_allocations` each carry an `intended_usage` enum (`gen_ops` / `growth` / `school_startup` / `teacher_training` / `project`) plus a nullable `fundable_project_id` FK to `fundable_projects`. The FK is populated only when `intended_usage = 'project'`. The importer's `INTENDED_USAGE_MAP` translates legacy Airtable strings (e.g. `project_ssj` → `intended_usage='project'`, `fundable_project_id='ssj'`; `General Operations` → `gen_ops`; `Seed Fund` → `school_startup`).
- `gift_allocations` — line items within a gift. `entity_id` FK → `entities` (formerly a free-text `recipient` column; now stored as the slug for the receiving fund entity). `fundable_project_id` FK → `fundable_projects` when intended_usage = 'project'. `formal_regional_restriction` and `formal_fund_use_restriction` booleans are orthogonal (where vs what the funder limited the money to).

**Many-to-many references via slug arrays**: many-to-many links (a funder having multiple regional priorities, an opportunity targeting multiple entities / projects / fiscal years, etc.) are stored as `text[]` columns of slug-PK references on the parent table rather than in dedicated junction tables. The choice is deliberate: slug PKs (e.g. `united_states__minnesota`, `wildflower_foundation`, `fy2024`) make orphaned or rotted references visually identifiable on inspection, in exchange for giving up DB-level FK enforcement on the individual array elements. Each such array column carries a **GIN index** so membership queries stay fast — **but only when written with array operators (`@>` / `&&` / `<@`), not with `= ANY(...)`** (which forces a sequential scan). Use `WHERE region_ids @> ARRAY['minnesota']::text[]` ("contains all of"), `WHERE region_ids && ARRAY['minnesota','wisconsin']::text[]` ("overlaps with any of"), or `WHERE region_ids <@ ARRAY[...]` ("subset of"). Drizzle's `arrayContains`, `arrayContained`, and `arrayOverlaps` helpers emit these operators directly.

**Other** (preserved from prior schema):
- `users` — Clerk-provisioned app users (kept for auth middleware).

### Imported record counts (current dev DB)

| Table | Rows |
|---|---|
| regions | 569 |
| schools | 131 (synced from dedicated Schools base) |
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

## Re-importing from Airtable

1. Use the Replit Airtable connector to fetch every record from the 15 tables of base `app8KUcmaHZ0AtcJZ` and write them as JSON to `/tmp/airtable-dump/<table>.json` (one file per table).
2. Run `node lib/db/src/import-airtable.mjs`. The importer:
   - Uses each Airtable record ID (`recXXXXXXXX`) as the Postgres primary key for every table except `regions`, so linked-record arrays in Airtable just work as foreign keys.
   - For `regions`, computes the human-readable slug PK and `display_path` per the rules above, builds a rec→slug map at region-insert time, and translates every region reference in the rest of the import (addresses.city_region_id, addresses.state_region_id, people.current_home_region_id, and the six `region_ids text[]` columns) through that map.
   - Inserts in dependency order; self-references (regions.parent, funders.parent) are filled in a second UPDATE pass.
   - Validates every FK against an in-memory set of inserted IDs and drops orphans rather than failing.
   - Uses `ON CONFLICT (id) DO NOTHING` so it's idempotent — running twice is safe.
   - Populates the `region_ids text[]` columns on the six referencing tables last.

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
