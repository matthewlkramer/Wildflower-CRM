---
name: scoped validation checks
description: The fast per-package verification checks and a concurrency trap between codegen and web checks.
---

# Fast scoped verification checks

Named validation checks (also root `check:*` scripts) verify just the touched
package instead of a full monorepo rebuild: `libs`, `api`, `web`, `codegen`,
`test-api`, `test-web`, `full`. Mapping + "which check when" lives in the
replit.md "Fast scoped checks" table — that is the source of truth.

## Don't run `codegen` concurrently with `web` / `test-web`

**Rule:** never run the `codegen` check in the same validation run (or shell) as
`web` / `test-web`.

**Why:** `codegen` (orval) wipes and regenerates
`lib/api-client-react/src/generated`. Anything importing it
(`lib/api-client-react/src/index.ts` re-exports `./generated`) sees a transient
missing-file window mid-regen. Symptom: a false "Vite could not resolve
'./generated'" failure in `test-web` that passes cleanly when re-run alone.

**How to apply:** sequence codegen before, not alongside, the web checks; if a web
check fails with a missing-`generated` import right after codegen, just re-run it.

## `test-api` needs a current dev DB

`test-api` includes DB-backed HTTP integration tests. A stale dev DB surfaces as
`column X does not exist` (e.g. `g.grant_year`) — that is cross-env schema drift
(see cross-env-db-schema-drift.md), not a code bug in the check.
