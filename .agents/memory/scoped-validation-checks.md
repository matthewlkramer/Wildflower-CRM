---
name: scoped validation checks
description: The fast per-package verification checks and a concurrency trap between codegen and web checks.
---

# Fast scoped verification checks

Named validation checks (also root `check:*` scripts) verify just the touched
package instead of a full monorepo rebuild: `libs`, `api`, `web`, `codegen`,
`test-api`, `test-web`, `full`. Mapping + "which check when" lives in the
replit.md "Fast scoped checks" table — that is the source of truth.

## Don't run `codegen` concurrently with `web` / `test-web` / `test-api`

**Rule:** never run the `codegen` check in the same validation run (or shell) as
`web` / `test-web` / `test-api`.

**Why:** `codegen` (orval) wipes and regenerates
`lib/api-client-react/src/generated` AND `lib/api-zod/src/generated`. Anything
importing them (`lib/api-client-react/src/index.ts` and `lib/api-zod/src/index.ts`
re-export `./generated`; the api-server imports api-zod) sees a transient
missing-file window mid-regen. Symptoms: a false "Vite could not resolve
'./generated'" failure in `test-web`, or a whole `test-api` file failing at import
with "Cannot find module './generated' imported from lib/api-zod/src/index.ts" —
both pass cleanly when re-run alone.

**How to apply:** sequence codegen before, not alongside, the web/test checks; if
a check fails with a missing-`generated` import right after codegen, just re-run it.

The `mark_task_complete` validation run fires all checks CONCURRENTLY, so it can
hit this race by itself (`test-web` fails on './generated', `test-api` fails a
whole file at import, `libs`/`typecheck`/`web` fail on TS6053 missing generated
files). Verify the failed checks sequentially in a shell; if they pass, the
validation failure is the race — safe to complete with a skip reason.

## `test-api` needs a current dev DB

`test-api` includes DB-backed HTTP integration tests. A stale dev DB surfaces as
`column X does not exist` (e.g. `g.grant_year`) — that is cross-env schema drift
(see cross-env-db-schema-drift.md), not a code bug in the check.

## Recovery when codegen overlapped anyway

If codegen runs concurrently with other checks (e.g. checkpoint validation fires
all workflows at once), orval can die mid-clean and leave a
`lib/api-client-react/src/generated/<tag>` subdir EMPTY. Every downstream check
then fails with `Cannot find module './generated'` — that cascade is corrupt
generated output, not real type errors.

**Recovery:** re-run `pnpm --filter @workspace/api-spec run codegen` alone first,
then re-run the failed checks (they'll pass unchanged). An `EADDRINUSE:8080` on
the api-server workflow in the same storm is an orphaned server process — just
restart the workflow (it usually clears itself).

## The api-server DEV workflow build hits the same race

The api-server workflow runs `pnpm run build && pnpm run start` (esbuild bundles
api-zod), so restarting it while the `codegen` validation workflow is mid-clean
fails the build with esbuild `Could not resolve "./generated"` in
`lib/api-zod/src/index.ts` — the server then serves nothing (proxy 502, e2e
"unable"). The validation storm can restart `codegen` MORE THAN ONCE, so a retry
can lose the race twice in a row. **How to apply:** after any validation storm,
confirm the codegen workflow is FINISHED before restarting the api-server
workflow, then verify with a curl through `localhost:80` (401 = up).
