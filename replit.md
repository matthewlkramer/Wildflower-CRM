# Wildflower Fundraising CRM

## Overview

Purpose-built fundraising CRM for Wildflower Schools, replacing Copper. A pnpm
workspace monorepo: TypeScript + React/Vite + Express 5 + PostgreSQL/Drizzle,
auth via Clerk.

The database schema mirrors the Wildflower "crm files" Airtable base
(`app8KUcmaHZ0AtcJZ`) and was seeded with ~14,200 records imported from Airtable.
The `funders` and `organizations` tables have been **consolidated** into a single
`organizations` table (an `issuesGrants` flag distinguishes grant-makers).

The product goal: give the Wildflower fundraising team one trustworthy place to run
the whole donor lifecycle — pipeline → commitments → cash in — with the money,
communications (Gmail/Calendar), and accounting (QuickBooks/Stripe) all reconciled
against the same donor records, so they can stop stitching Copper, spreadsheets, and
inboxes together by hand.

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
  db/                        — Drizzle schema, importer script, DB connection
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
`testClerkAuth: true` and an `@wildflowerschools.org` email to get a programmatic
session. The session is already authenticated — never drive the Clerk sign-in UI
or captcha; navigate straight to the target path. Treat any captcha that appears
mid-run as noise (retry), not a blocker.

## Features

- **CRM core** — organizations (grant-makers flagged via `issuesGrants`), people,
  households, opportunities & pledges, gifts & payments, allocations, payment
  intermediaries, regions, schools, fiscal years. Pledges are the slice of
  opportunities that ever reached commitment (`was_pledge`, or stage
  conditional/written). Dashboard / projections / grants-calendar analytics are
  derived server-side.
- **Opportunity derivation** — `status` (`open` / `pledge` / `cash_in` / `dormant` /
  `lost`) is **fully calculated** from stage + payments + the user-set `loss_type`
  override — never written directly (`status='pledge'` comes only from stage
  `written_commitment`; full payment ⇒ `cash_in`). Computed by a pure
  `deriveOppFields` + a DB-touching `applyDerivedOppFields` wrapper (backfill script
  available). A separate sticky `was_pledge` flag — latched once a row hits a
  commitment stage or gets a grant letter, never auto-cleared — drives the
  Pledges-page filter, not status. Grant-letter upload via object storage (presigned
  GCS URL).
- **Fundraising categories (revenue vs loan capital)** — loan-fund capital is a
  first-class track parallel to revenue across analytics, never mixed in.
  `fundraising_category` enum (`revenue` | `loan_capital`); opportunities carry
  `fundraisingCategory` (NOT NULL default `revenue`); `fiscal_year_entity_goals`
  PK is `(fiscalYearId, entityId, category)` so each track has its own goal. Loan
  money = `loan_fund_investment` gifts + loan-capital opps/pledges. Analytics
  (`dashboard-summary`, `fiscal-year-breakdown`, projections) split per category;
  the dashboard renders two tracks per fiscal year, each with received /
  committed / weighted-open / goal. Goals routes take a `:category` path param
  (defaults to `revenue`). Non-destructive: all pre-existing data is `revenue`.
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
  and stages rows in a review queue (`/staged-payments`, "Finance Reconciliation"
  nav — formerly "QuickBooks Review"). Each staged row carries an `entity_id`
  attributed from text markers (`detectEntity`), filterable by entity in the
  queue; fiscally sponsored money is attributed + kept in review (no longer
  auto-excluded). "sunlight" is intentionally not auto-attributed.
  A fundraiser fixes the donor match and approves/rejects; approve mints a
  `gifts_and_payments` row in a tx (Donor XOR via `validateGiftInvariants`).
  Idempotent by `(realmId, qbEntityType, qbEntityId, qbLineId)` (deposits stage per
  line; non-deposit rows use an empty `qbLineId`); staged rows retained after
  approve/reject for dedupe. Tokens + realmId encrypted at rest; OAuth/token
  endpoints are env-shared, the data host is env-derived (`QUICKBOOKS_API_BASE`,
  defaults to the production Intuit host). Pull-only — never writes back to QB.
- **Flodesk subscriber sync** — replaces the cancelled Mailchimp plan. Syncs
  PEOPLE only into ONE Flodesk segment. Outbound (CRM → Flodesk) fires
  fire-and-forget on person create/update: eligible people (`newsletter` true,
  `unsubscribedToNewsletter` false, has a usable email) are upserted + added to
  the segment; ineligible people are unsubscribed. Inbound reconcile (Flodesk →
  CRM) runs daily off-hours (America/Chicago, advisory-locked) and is monotonic —
  it only ever SETS `unsubscribedToNewsletter = true`. Precedence: a Flodesk
  unsubscribe always wins (outbound mirrors it back instead of resurrecting the
  subscriber). Config: `FLODESK_API_KEY` secret + `FLODESK_SEGMENT_ID` env (auth
  defaults to HTTP Basic, override via `FLODESK_AUTH_SCHEME`); the sync is a safe
  no-op until both are set. No campaign/open analytics (Flodesk's API has none).
  Manual trigger: `pnpm --filter @workspace/api-server run sync:flodesk`.
- **Stripe sync + Stripe↔QuickBooks reconciliation** — a second pull-only money
  source parallel to QuickBooks. A scheduled (30-min) + on-demand worker pulls Stripe
  payouts (`stripe_payouts`) and the individual gross charges behind them
  (`stripe_staged_charges`). The reconciliation queue (`/stripe-reconciliation`) ties
  a coarse QuickBooks deposit/payout lump to its individual Stripe charges: the
  per-charge Stripe gifts become the precise record, the coarse QB-derived gift is
  archived, and the QB staged row is excluded with reason `processor_payout` (set
  ONLY on human confirm) so the same money is never booked twice. Key files:
  `stripeSync.ts`, `stripeReconcile.ts`, `stripeMatch.ts`, `stripeConfirm.ts`.
- **Revenue-accounting coding (CFO "Revenue Extractor")** — gift/pledge allocations
  capture accounting codes alongside scope, derived from donor kind + fundable
  project + region by `revenueCoding.ts`, with per-fund-entity overrides
  (fiscal-sponsee defaults, keyed on `entities.id`) in `entity_coding_rules` (GL
  account list in `revenue_accounts`). `restriction_type`
  (`unrestricted` / `purpose` / `time` / `both` / `unclear` / `na`) never silently
  defaults `unclear` to unrestricted — it flags for human review. `deferred_revenue`
  is captured, not computed (the CRM does not derive AR).
- **Email & calendar sync + intelligence** — per-user Gmail/Calendar sync into
  `email_messages` / `calendar_events` (Chicago-time-aware scheduler, advisory-locked,
  matched to CRM entities with suppression controls). AI "email intelligence" (Claude
  via `integrations-anthropic-ai`) extracts signals into `email_proposals` (job
  changes, bounces, signature updates, grant opportunities, thank-you
  acknowledgments) that a reviewer accepts/rejects; the prompt is versioned and
  admin-tunable (`email_intel_prompts`). Grant opportunities also feed a team-shared,
  cross-inbox `grant_leads` queue.
- **Tasks + AI next-step suggestions** — manual + reporting-deadline tasks (`tasks`)
  with AI-proposed next steps (`task_proposals`), auto-generated only on true first
  view and refreshed explicitly thereafter.
- **Entity merge** — transactional collapse of duplicate organizations/people into a
  primary: re-points every FK reference, merges multi-value arrays, archives the
  duplicate (SELECT … FOR UPDATE on the merged rows first). A FK-inventory test fails
  on schema drift so a newly-added FK can't silently be missed.
- **Meeting notes** — paste-a-transcript flow producing an editable AI summary +
  action items, surfaced in the activity timeline.
- **Archive (soft-delete)** — app-wide default; `archived_at` replaces hard delete in
  both list and detail. Archived rows drop out of list views by default (admin-only
  "show archived", LIST only) and archived gifts are excluded from financial /
  pledge-paid totals. Few explicit hard-delete exceptions remain (gift merge,
  QuickBooks revert).

## Known follow-ups (non-blocking)

- **Production data changes** — prod now holds **live data**, so the old "overwrite
  data" cutover (replace prod wholesale with dev's) is no longer safe. The agent
  cannot write to prod. Schema/code changes ship via the normal Publish flow;
  every prod **data** change must be delivered as a reviewed, idempotent SQL file
  (see `lib/db/migrations/` + its runbooks) and applied by a human with
  `psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <file>.sql`.
- **Stale importer** — `lib/db/src/import-airtable.mjs` still targets the OLD split
  funders/organizations model and must be updated before any re-import (it will
  otherwise fail). (`lib/db/SCHEMA.md` has been refreshed to the consolidated model.)
- ~~**FY boundary uses UTC**~~ — RESOLVED: `computeCurrentFiscalYear` in
  `routes/analytics.ts` already derives the current fiscal year via
  `Intl.DateTimeFormat` with `America/Chicago`, so the dashboard FY boundary is
  timezone-correct. (SQL `fyBucket` derivations operate on `date` columns, which
  carry no timezone, so they need no change.)
- **`gmail.send` scope** — new OAuth scope; each user must reconnect Google once.
  Until then the extension cleanly falls back to the legacy single-pixel send.
- **Anonymous masking gaps** — join-projection name references (role rows, household
  members, colleague/affiliation lists) aren't masked yet; needs `anonymous` +
  `ownerUserId` added to those endpoint projections.
- **Media ingest** — no relevance filtering on person-name searches (common names
  → false positives); live GDELT calls are flaky from the dev sandbox but work in
  the deployed env.
