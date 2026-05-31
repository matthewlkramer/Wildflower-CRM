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

**Testing note (Clerk + Cloudflare captcha):** The Cloudflare/Clerk captcha that sometimes appears during sign-in CAN be circumvented in e2e tests. Use the testing skill's `runTest` with `testClerkAuth: true` to establish a programmatic Clerk session (use an `@wildflowerschools.org` email). The programmatic session is already authenticated, so the test plan should never touch the Clerk sign-in/sign-up UI or the captcha — just navigate directly to the target path. If a captcha/UI form ever appears mid-run, treat it as noise and navigate straight to the destination; do NOT mark the run as blocked over it (retry if a transient captcha trips it up).

## Stage 2 — status

Stage 1 rewrote the DB schema and seeded it from Airtable. Stage 2 has now landed:

- **OpenAPI spec** (`lib/api-spec/openapi.yaml`) — mirrors the new tables. Includes the analytics tag (`/dashboard-summary`, `/projections-by-fy-entity`). Regenerate hooks/zod after edits via `pnpm --filter @workspace/api-spec run codegen`.
- **API server** (`artifacts/api-server/src/routes/`) — all CRUD routes for the new tables are implemented (funders, people, organizations, households, payment-intermediaries, opportunities-and-pledges, pledge-allocations, gifts-and-payments, gift-allocations, regions, schools, etc.) plus the two new analytics endpoints in `routes/analytics.ts`. Dashboard / projections / grants-calendar are now derived server-side from the new tables.
- **Frontend** (`artifacts/wildflower-crm`) — all 17 pages are on the new schema and the generated hooks (`useListPeople`, `useListFunders`, `useListHouseholds`, `useListOpportunitiesAndPledges`, `useListGiftsAndPayments`, etc.). `/pledges` + `/pledges/:id` re-use the opportunities views (pledges are a status-filtered slice of opportunities-and-pledges in the new model). Donor xor (`funderId` / `individualGiverPersonId` / `householdId`) is wired through opportunity-detail and gift-detail.
- **Zod schemas** — there is no `lib/db/src/zod/` package and nothing imports one. Server-side validation lives in `@workspace/api-zod`, regenerated from the OpenAPI spec by orval. `drizzle-zod` remains in `lib/db/package.json` for opportunistic per-route use but is not the chosen request-validation path.
- **API contract gaps** (resolved 2026-05-23): `household_id` is now in opps + gifts (response + Create/Update bodies + list filters), `historical_names` (text[]) in funders + organizations (response + Create/Update bodies), `private_wealth_manager` added to `PaymentIntermediaryType` enum. Request-level invariant validation for the `donor_xor` and `closed_requires_completion_date` CHECK constraints is wired into the opps + gifts POST/PATCH handlers via shared `validateOppInvariants` / `validateGiftInvariants` helpers in `@workspace/api-zod` — PATCH validates merged post-update state so partial updates can't bypass the check. API returns 400 instead of 500 on invariant violations.

### Known follow-ups (non-blocking)

- **FY boundary uses UTC.** `currentFiscalYear` in `/dashboard-summary` is computed from `getUTCMonth/getUTCFullYear`. Around midnight on Jun 30 / Jul 1 it can flip up to a day early/late depending on the org's local timezone. Worth pinning to America/Chicago (or whichever timezone Wildflower books in) before next fiscal year-end.

### Stage 3 — status

- **Grant-letter upload UI** — `POST /api/storage/uploads/request-url` (Clerk-gated) issues a presigned GCS URL; client uploads directly to GCS then PATCHes the opp with `grantLetterUrl` (`/api/storage/objects/<id>`) + `grantLetterFilename`. Server-side `applyDerivedOppFields` flips `wasPledge` sticky-true on the next read. Component: `artifacts/wildflower-crm/src/components/grant-letter-upload.tsx`. Routes copied from the object-storage skill template into `artifacts/api-server/src/routes/storage.ts`.
- **Tests** — vitest configured on `@workspace/api-server` (`pnpm --filter @workspace/api-server run test`). Coverage: `deriveOppFields` derivation matrix + dormant/lost stickiness + wasPledge stickiness (`src/__tests__/derive-opp-fields.test.ts`), donor-xor invariants (`src/__tests__/donor-xor.test.ts`). `pledgeStage.ts` was refactored so `deriveOppFields` is a pure function reusable by tests + the DB-touching `applyDerivedOppFields` wrapper.
- **Backfill** — `pnpm --filter @workspace/api-server run backfill:derived-opps` (`src/scripts/backfill-derived-opp-fields.ts`) iterates every opportunity id and calls `applyDerivedOppFields`. Idempotent.

### Stage 4 — status (automated media-mention ingestion)

Replaces manual Google Alerts with an in-app scheduled job that pulls press coverage from **GDELT DOC 2.0** (free, no API key).

- **Targets** — ALL funders + people whose `capacityRating` is `tier_250k_1m` or `tier_1m_plus` (`buildIngestTargets` in `artifacts/api-server/src/lib/mediaIngest.ts`). People need ≥2 name tokens (first+last) to be searchable, else skipped.
- **Corporate/bank foundations search the FOUNDATION, not the parent company.** For funders whose `fundingEntitySubtype` is `corporate_foundation` or `bank_foundation`, `foundationSearchName` normalizes the stored name to the philanthropic arm (e.g. `Wells Fargo / Wells Fargo Foundation` → `"Wells Fargo Foundation"`; `Old National Bank / Foundation` → `"Old National Bank Foundation"`; bare `Bank of America` → `"Bank of America Foundation"`). This avoids drowning in unrelated corporate/market news. Other subtypes keep their name verbatim.
- **Client** — `src/lib/gdelt.ts`: phrase-search query builder + pure parse helpers (`parseGdeltArticles`, `gdeltDateToISO`), `searchGdelt` never throws (returns `[]`), with retry/backoff on transient connect timeouts / 429 / 5xx.
- **Dedupe is DB-atomic.** `media_mentions.url` has a UNIQUE index (`media_mentions_url_uq`). `upsertArticle` does `INSERT ... ON CONFLICT (url) DO UPDATE` that array-appends the entity id (with a WHERE guard so an already-linked id is a no-op). `xmax = 0` in RETURNING distinguishes created vs linked. This makes concurrent runs safe (no dup rows, no lost merges) — do NOT revert to read-then-write.
- **No AI summary by design.** GDELT gives a factual headline, stored in the new `title` column; `aiSummary` stays null for auto items (summarizing a bare headline risks fabricating claims about a donor). Frontend `MediaMentionRow` shows `title || publicationName`. Surfaced via the existing activity feed / media panel.
- **Scheduler** — `src/lib/mediaIngestScheduler.ts`: in-process, ticks every 30 min, runs once/day in the America/Chicago 2–5am off-hours window, guarded by a global pg advisory lock (keys `9001`/`1`, distinct from syncLock) + the `media_ingest_state` singleton table (id `"singleton"`). `runMediaIngestIfDue()` returns the `IngestSummary` or `null` (skipped). Disable with `DISABLE_MEDIA_INGEST=1` (or `DISABLE_SYNC_SCHEDULER=1`).
- **Manual trigger** — `pnpm --filter @workspace/api-server run ingest:media` (`src/scripts/ingest-media-mentions.ts`) goes THROUGH `runMediaIngestIfDue({force:true})` so it shares the same lock + state (never bypasses them). Env overrides (validated): `MEDIA_INGEST_MAX_ENTITIES`, `MEDIA_INGEST_TIMESPAN_DAYS`, `MEDIA_INGEST_THROTTLE_MS`.
- **Tests** — `src/__tests__/media-ingest.test.ts` covers the pure helpers (date/article parse, query builder, `personDisplayName`, `mergeEntityId`).
- **Schema/contract** — `title` + `source` added to `media_mentions` and to MediaMention/Input/Update in `openapi.yaml` (codegen regenerated).

**Known follow-ups (non-blocking):** (1) No relevance filtering on person-name searches — common names can yield false-positive mentions; consider a confidence/affiliation filter. (2) A full ~1000-entity sweep where GDELT is broadly failing (max retries per entity) could in theory spill past the 3-hour off-hours window — consider an overall run deadline / continuation cursor if it becomes an issue. (3) Live GDELT calls are blocked/flaky from the dev sandbox (works in deployed env); verify end-to-end after publish.

### Stage 5 — status (filter chooser on all 4 list pages)

Mirrors the existing column chooser: a per-page "Filters" menu lets users toggle which filter controls show in the toolbar. Applies to individuals, funding-entities, opportunities (shared with pledges), and gifts.

- **Infra** — `src/lib/filters.tsx` (`FilterDef`/`FiltersState` types + `resolveFilters` / `defaultFiltersState` / `isDefaultFiltersState`), `src/components/filters-menu.tsx` (the chooser), `src/components/presence-filter.tsx` (`PresenceFilter` + `PresenceValue = "has" | "blank" | undefined`).
- **Saved-view backward-compat** — `FiltersState` is `{ known: string[]; hidden: string[] }`, persisted as `null` when at registry defaults (keeps saved-view shallow-equal stable for views predating this feature). `resolveFilters` uses `known` to detect filters a saved view predates: an unknown registry filter follows its registry `defaultVisible` default, so newly-introduced opt-in filters stay hidden until the user has actually seen them. Required filters (the name search box) can never be hidden. Hiding an active filter invokes its `clear` callback so a hidden filter never silently narrows results.
- **Presence filters** — rollup/computed columns get presence-based filters ("has" value vs "blank") instead of value filters. Per page: individuals (lifetimeGiving, lastGift, openAsks, activeAffiliation), funding-entities (lifetimeGiving, openAsks, primaryContact), opportunities (paid, coveredFys, entities), gifts (entities, usages, grantYears). Presence params are sent as `<field>Presence` query params.
- **Server WHERE semantics** (all 4 routes) — numeric (lifetimeGiving/paid): has = `> 0`, blank = `<= 0`; date/EXISTS: has = NOT NULL / EXISTS, blank = the opposite; counts/array rollups: has = `> 0` / EXISTS, blank = `= 0` / NOT EXISTS. Funders/people reuse the same correlated subquery expression in SELECT and WHERE to avoid drift.
- **Contract** — presence params added to `lib/api-spec/openapi.yaml` for the 4 list endpoints; codegen regenerated.
- **Tests** — `src/lib/filters.test.ts` covers `resolveFilters` / `defaultFiltersState` / `isDefaultFiltersState` including saved-view backward-compat (opt-in filters staying hidden for predating views). Full `pnpm run typecheck` + 32 frontend tests pass.

**Known follow-ups (non-blocking):** (1) No API-level integration tests for the presence params yet (helpers are unit-tested). (2) `isDefaultFiltersState` is not tolerant of stale keys from a future filter *removal* (could read as "customized" in long-lived saved views) — only matters if a filter is later deleted from a registry.
