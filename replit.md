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
pnpm --filter @workspace/scripts run cleanup:test-users  # Archive test users after e2e runs
```

**Important**: After changing the DB schema, always run both `pnpm --filter @workspace/db run push` AND `cd lib/db && pnpm exec tsc -p tsconfig.json` to keep declarations in sync.

## Database

The schema lives in `lib/db/src/schema/` and mirrors the Airtable "crm files" base, with one tweak: `regions` uses human-readable slug PKs while every other entity uses the Airtable record ID directly as PK so re-imports stay idempotent. Donors on `opportunities_and_pledges` and `gifts_and_payments` are one of three mutually-exclusive options, DB-enforced via the `opportunities_and_pledges_donor_xor` / `gifts_and_payments_donor_xor` CHECK constraints: `organization_id` (organizational), `individual_giver_person_id` (single person), or `household_id` (joint account). The API server pre-validates the same invariant in opps + gifts POST/PATCH handlers via `validateOppInvariants` / `validateGiftInvariants` in `@workspace/api-zod`, so the API returns 400 instead of letting the DB raise a 500. Many-to-many links use `text[]` slug arrays with GIN indexes — query with array operators (`@>`, `&&`, `<@`), never `= ANY(...)`.

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

### Stage 6 — status (Superhuman-style per-recipient open tracking, "Path A")

When a tracked Gmail send has **2+ distinct recipients (To+Cc) and no attachments**, the SERVER sends one individualized copy per recipient via the Gmail API. Each copy shows the full To/Cc group (so it reads as a normal group email) but carries a unique tracking pixel — giving true per-person open attribution. Single-recipient sends, replies/forwards, attachment/inline-image sends, and any failure all fall back to the existing single-pixel + Gmail-send path.

- **OAuth scope** — `gmail.send` added in `googleOauth.ts` (`GMAIL_SEND_SCOPE`). **Users must reconnect Google once** to grant it.
- **Extension token** — the extension runs on mail.google.com with no Clerk session, so each user generates a personal token in CRM **Settings → Email tracking extension** (`extension-token-section.tsx`) and pastes it into the extension popup. Stored on `users.extension_token` (UNIQUE). Server resolves token → user → that user's Google tokens; the per-recipient copies send from the user's own mailbox (`users/me`). Endpoints: `GET`/`POST /api/email-tracking/extension-token` (Clerk-gated; POST rotates). The extension authenticates `POST /api/email-tracking/send` via the `X-Extension-Token` header (`requireExtensionToken` middleware).
- **MIME is hand-rolled** — `src/lib/mime.ts` (`buildRawMessage`: RFC822 + base64url + RFC2047 encoded-word headers), no googleapis/nodemailer dep. `src/lib/gmailSend.ts` (`sendRawMessage` + `GmailSendError`) posts raw + shared `threadId` so the sender's Sent folder threads the copies together.
- **Per-recipient rows** — one `tracked_emails` row per recipient, sharing `group_id`; `recipient` = the single address; `gmail_message_id` / `gmail_thread_id` recorded. Schema: `group_id` + gmail ids + index on `tracked_emails`, `extension_token` on `users`.
- **Server-send rows skip sender-peek suppression** (`senderIp=null`) since there's no live compose pixel-peek; the Gmail-delivery-proxy 10s window suppression still applies. Row is inserted after the send succeeds.
- **/search group breakdown** — `shapeGroupWithViews` aggregates a `recipients[]` array (per-recipient id + address + totalViews + lastView) plus `groupId` onto `/search` and `/:id` responses. The extension sidebar renders a "By recipient · N/M opened" section when `recipients.length >= 2`.
- **Duplicate-send safety** — `sendTrackedEmail` returns a 3-way outcome so the extension never double-sends: `sent` (discard draft), `not_sent` (server delivered nothing — 400/401/409 or a 502 whose `details.sent` is empty — so fall back to the legacy Gmail send), `uncertain` (partial 502 with `details.sent` non-empty, unknown 5xx, or no response — a copy may already be out, so HALT: show a "check Sent before resending" toast and do NOT Gmail-send). `content.ts`'s `trySendPerRecipient` maps these to `use-legacy` / `done` / `halt`. The common "haven't reconnected Google for the new scope" case is 409 → `not_sent` → safe fallback, so the email still goes out.
- **Extension** (`tools/magio-extension`, NOT in the pnpm workspace) — popup token field (`popup.tsx` + `storage.ts` token persistence); send interception in `content.ts` (`trySendPerRecipient` gates eligibility, routes through `sendTrackedEmail` with `X-Extension-Token`, discards the Gmail draft on success, falls back only when the server delivered nothing, halts on uncertain); `gmail.ts` helpers (`getToAddresses`/`getCcAddresses`/`getBccAddresses` scoped per labeled region so Bcc never leaks into a visible header, `hasAttachments` covers file + inline-image). **Bcc present → fall back** (a per-recipient copy can't represent Bcc). Build with the dev URL baked in: `cd tools/magio-extension && PLASMO_PUBLIC_API_URL="https://$REPLIT_DEV_DOMAIN" node_modules/.bin/plasmo build && node_modules/.bin/plasmo package && cp build/chrome-mv3-prod.zip build/wildflower-tracking-extension.zip`.
- **Contract** — `SendTrackedEmailBody`, `SendTrackedEmailResult`, `ExtensionTokenResponse`, `TrackedEmailRecipient`, and `groupId`/gmail ids on `TrackedEmail` added to `openapi.yaml`; codegen regenerated. **Tests** — `mime.test.ts` (RFC822/base64url/encoded-word) added; full `pnpm run typecheck` + 122 api-server tests + extension `tsc --noEmit` all green.

**Known follow-ups (non-blocking):** (1) `gmail.send` is a new scope — until each user reconnects Google, `POST /send` will 4xx (missing scope) and the extension cleanly falls back. (2) Reply/forward detection is heuristic (subject prefix `Re:`/`Fwd:` or inline-in-thread) — a multi-recipient *new* compose whose subject happens to start with those words is treated as a reply and uses the safe path (no per-person attribution, but correct send). (3) `getToAddresses`/region scoping relies on English aria-labels (`To`/`Cc`/`Bcc`); a non-English Gmail UI would yield no labeled region and fall back to the safe path. (4) Live Gmail send untested from the dev sandbox; verify end-to-end after publish + reconnect. (5) No server-side idempotency key on `POST /send` yet — the `uncertain` HALT path prevents *automatic* double-sends, but a user who manually retries after an uncertain outcome could still resend; an idempotency key (client-generated per compose) would make retries fully safe.

### Stage 7 — status (anonymous funders/people, UI-only name hiding)

`anonymous boolean not null default false` added to **funders** + **people** (schema, `openapi.yaml` Funder/Person + Create/Update bodies, codegen regenerated). When `anonymous` is true, the real name is masked to `"Anonymous"` everywhere **except** for the record's owner (`ownerUserId`) and admins (`users.role === "admin"`).

- **UI-only by design** — anonymity is **NOT** enforced server-side; the real name is still in API responses. Routes are unchanged (list selects use `getTableColumns`, create/update spread `...body`). This was an explicit product decision.
- **Helpers** — `artifacts/wildflower-crm/src/lib/visibility.ts`: `canSeeIdentity(entity, viewer)` (true when not anonymous, or viewer is admin/owner) drives **name display**; `canManageIdentity(entity, viewer)` (admin/owner only, **independent of the anonymous flag**) drives the **Anonymous toggle** visibility. These are deliberately separate — gating the toggle on `canSeeIdentity` would let any viewer toggle a currently-visible record. `displayFunderName` / `displayPersonName` mask using `canSeeIdentity`.
- **Masked surfaces** — list pages (individuals, funding-entities): name cell, sort accessor, and checkbox `aria-label`; detail pages: title, "Edit name" button (gated by `canSeeName`), delete-dialog title, and the funder parent/subsidiary relation cards; the global command palette (people + funders). The Anonymous toggle on both detail pages is gated by `canManageIdentity`.
- **Tests** — `src/lib/visibility.test.ts` covers both helpers + display masking. Full `pnpm run typecheck`, 43 frontend tests, and 195 api-server tests pass.

**Known follow-ups (non-blocking):** Relational references that come from join *projections* carrying only a `personName`/name string (NOT `anonymous` + `ownerUserId`) are **not yet masked**: role rows, household members, and colleague lists on the individual detail page (all `PeopleEntityRole.personName`), and the funder-people affiliation rows. Masking these requires adding `anonymous` + `ownerUserId` to those endpoint projections (OpenAPI + server SQL + codegen) so the client can decide — still UI-only, just a broader contract change.
