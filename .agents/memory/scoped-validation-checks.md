---
name: scoped validation checks
description: The fast per-package verification checks, the changed-scope defaults, and the (now mostly fixed) codegen concurrency trap.
---

# Fast scoped verification checks

Named validation checks (also root `check:*` scripts) verify just the touched
package instead of a full monorepo rebuild: `libs`, `api`, `web`, `codegen`,
`test-api`, `test-api-unit`, `test-api-changed`, `test-web`, `test-web-changed`,
`full`. Mapping + "which check when" lives in the replit.md "Fast scoped
checks" table — that is the source of truth. Default loop: scoped typecheck +
`*-changed` tests; `full` + full `test-api` once before finishing.

## The `codegen` CHECK is now non-mutating and concurrency-safe (2026-07)

`codegen:check` regenerates into a TEMP mirror of the repo layout
(`CODEGEN_OUT_ROOT` env honored by orval.config.ts + gen-index.mjs), diffs
against the committed generated dirs, and compiles only the two generated libs.
It never touches shared source, so running it concurrently with any other check
(including the mark_task_complete all-checks-at-once storm) is safe — verified
by running all 7 checks simultaneously, all green.

**The regen SCRIPT is now atomic too (2026-07).** `pnpm --filter
@workspace/api-spec run codegen` (lib/api-spec/codegen.sh) generates into a
same-filesystem temp mirror, then swaps each generated dir in with a single
`mv --exchange -T` (renameat2 RENAME_EXCHANGE). The dirs are never absent or
half-written, so running codegen concurrently with tests/typechecks/builds is
safe — verified with a full check storm during a live regen, all green. If
output is byte-identical, no swap happens (keeps tsc cache warm). An
`EADDRINUSE:8080` in a check storm is an orphaned server process — restart the
workflow.

**Lib declaration emit is flock-serialized (2026-07).** A second race: when
generated sources get fresh mtimes, concurrent `tsc --build` runs re-emit lib
`.d.ts` while a leaf typecheck reads them mid-rewrite → false TS2367/TS2305 on
recently renamed types, passing in isolation. All lib-emitting builds AND leaf
typechecks share `flock /tmp/wf-tsc-libs.lock`; leaf typechecks also rebuild
libs first under the lock, so they never read stale declarations. Keep the
flock (and the build-libs-first step) if editing any `typecheck` script.

## `test-api` runs on a dedicated test DB (2026-07)

vitest provisions and targets `<devdb>_test` — see dedicated-test-db.md. A
"column X does not exist" in tests now means the TEST DB schema stamp predates
your schema change only if you bypassed the hash (it hashes lib/db/src/schema);
for the dev SERVER the cross-env-db-schema-drift.md note still applies.
Concurrent vitest invocations (test-api / test-api-changed / test-api-unit)
now serialize the WHOLE run via `flock /tmp/wf-test-db.lock` in the api-server
test scripts (2026-07). Setup-only advisory locking was insufficient: a second
run's global setup truncates all tables mid-first-run → flaky assertions and
deadlocks. test:unit shares the same global setup, so it takes the lock too.
Keep the flock if editing any api-server test script.

## Merge-time generated-dir clobbering (parallel contract tasks)

When two parallel tasks both touch `lib/api-spec/openapi.yaml`, each regenerates
`lib/api-client-react`/`lib/api-zod` from its own spec. At merge, one side's
generated dirs win and the other side's frontend/server code fails typecheck
with TS2305 "no exported member" / TS2339 on fields it added. Fix: the
post-merge script (`scripts/post-merge.sh`) runs
`pnpm --filter @workspace/api-spec run codegen` to regenerate from the merged
spec. If a completion-time validation fails with errors referencing code that
does not exist in your tree, it is this merge artifact, not your change.
