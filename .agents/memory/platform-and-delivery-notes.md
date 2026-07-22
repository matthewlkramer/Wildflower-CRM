---
name: Platform and delivery notes index
description: Routing index for toolchain, build, deploy, prod-migration, and API-plumbing gotchas that aren't tied to one CRM feature. Read only the entries matching the symptom.
---

# Platform and delivery notes

One-line routing entries for platform/toolchain/delivery lessons. Read only the
topic files relevant to the symptom.

## Build, typecheck, and environment

- [api-server runs a built bundle](wildflower-api-server-build.md) — schema/DB drift (e.g. "column X does not exist" 500) may be a stale build; restart rebuilds, check newest log.
- [Verify under CPU throttling](build-verify-cpu-throttling.md) — monorepo tsc --build/orval/runTest blow past tool caps; let one full build finish to warm .tsbuildinfo (then incremental is fast); e2e can exceed the 600s cap.
- [Vite build-time env gating](vite-build-env-gating.md) — artifact vite.config must validate PORT/BASE_PATH only in `command==="serve"`; root build builds ALL artifacts (incl. non-deployed design ones), so build-time throws crash the deploy.
- [api-zod must stay env-neutral](api-zod-cross-env.md) — imported by server AND browser; no URL/node/DOM globals; validate via pure regex + superRefine, PATCH re-validates merged state.
- [Mockup preview iframe URLs](mockup-preview-url.md) — canvas iframes must use https://$REPLIT_DOMAINS/__mockup/preview/… (shared proxy), NEVER :8000 (unreachable → "couldn't reach this app").

## API plumbing

- [parseOrBadRequest 2nd arg](parse-or-bad-request-arg.md) — pass req.body/req.query, never req; wrong call type-checks (param is unknown) but always 400s at runtime; only HTTP tests catch it.
- [Router self-prefix + 401 mask](router-self-prefix-401-mask.md) — reconciliation routers self-prefix full paths; requireAuth-before-routing makes curl 401 mask an unregistered route (verify authed, not bare curl).
- [Shared multi-outcome handler gating](shared-outcome-flag-gating.md) — gate behavior on the explicit outcome flag, not a shared body field's presence; a stray field else silently hijacks another outcome.
- [Raw ::date cast needs round-trip validation](raw-date-cast-validation.md) — query-param dates feeding a raw `::date` cast need a Date round-trip check (regex passes 2026-13-40 → Postgres 500); return 400.
- [Deprecated-column response leaks (no Zod stripping)](deprecated-column-response-leak.md) — responses are plain res.json, so a @deprecated-but-still-physical Drizzle column leaks through EVERY full-row select that reaches the client; route all response reads through ONE scrubbed projection.
- [Deprecated-column drop audit](deprecated-column-drop-audit.md) — a "pure drop" grep must cover .col dot-access, col: object-key writes, AND table alias() reads; trust full typecheck over grep + stale @deprecated comments.

## Prod migrations and data operations

- [Additive columns need a migration file](schema-column-migration-required.md) — a new Drizzle column also needs a reviewable idempotent ADD COLUMN IF NOT EXISTS migration+runbook; code-review REJECTS without it even though Publish also creates columns.
- [Migration "already applied" claims can be false](migration-applied-claims.md) — probe dev+prod information_schema before writing a "missing" drop; header comments and task briefs both lied once.
- [Prod data-seed slug/id mismatch](prod-data-seed-slug-mismatch.md) — id/slug-matched UPDATE can COMMIT yet flag the wrong row count; verify by affected-row count/state, not clean exit.
- [prod→dev data sync](prod-dev-data-sync.md) — mirror prod rows into dev w/o reverting dev edits; funders text overflows json_agg; apply via json_populate + replica mode; verify INCLUDE→EXCLUDE FKs first.
- [Prod-migration rehearsal + retroactive supersede](prod-migration-rehearsal.md) — rehearse repair SQL on a schema-clone scratch DB (run twice, md5 snapshot); ties written by SQL never trigger runtime supersede, so the repair file must include the ledger moves.
