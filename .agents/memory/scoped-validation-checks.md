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

**The regen SCRIPT still mutates.** `pnpm --filter @workspace/api-spec run
codegen` wipes and rewrites `lib/*/src/generated` in place. Run it ALONE —
never while tests/typechecks/the api-server build are running. If a check fails
with "Cannot find module './generated'" right after a regen, that's the
transient window: re-run codegen alone, then re-run the failed check. An
`EADDRINUSE:8080` in the same storm is an orphaned server process — restart the
workflow.

## `test-api` runs on a dedicated test DB (2026-07)

vitest provisions and targets `<devdb>_test` — see dedicated-test-db.md. A
"column X does not exist" in tests now means the TEST DB schema stamp predates
your schema change only if you bypassed the hash (it hashes lib/db/src/schema);
for the dev SERVER the cross-env-db-schema-drift.md note still applies.
Concurrent vitest invocations (test-api + test-api-changed) serialize their
setup on an advisory lock by design.
