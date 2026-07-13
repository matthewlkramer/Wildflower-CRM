---
name: Verify under CPU throttling
description: How to get typecheck / tsc --build / orval / e2e to complete in this CPU-throttled container despite the foreground tool cap.
---

This container is sometimes severely CPU-throttled — heavy CPU jobs that normally
finish in ~90s can take many minutes, blowing past the ~120s foreground bash cap
and even the 600s `code_execution` cap.

**`pnpm run typecheck` / `tsc --build`:** a from-cold full build can exceed the
foreground cap (even a single composite lib timed out >110s). The build is
INCREMENTAL — each project that finishes writes its `.tsbuildinfo`. So:
- Let ONE full `tsc --build` complete (background it with `nohup ... &` and poll,
  or just run `pnpm run typecheck:libs` repeatedly — each run resumes from cache
  and makes progress). `nohup` background jobs CAN complete here and warm the
  cache even though the launching tool call returns.
- Once libs are warm, `pnpm run typecheck:libs` returns RC=0 in seconds and the
  full `pnpm run typecheck` (libs + 4 leaf packages) fits in one foreground call.
- `tsc --build` prints nothing on success; an empty log ≠ stuck. Confirm progress
  via `.tsbuildinfo`/`dist` mtimes, not stdout (output is block-buffered to files).
- The LEAF artifact typechecks (`tsc -p tsconfig.json --noEmit`) are ALSO incremental
  now — `incremental:true` lives in `tsconfig.base.json`, so each leaf writes its own
  `tsconfig.tsbuildinfo` on success. A warm re-run cut wildflower-crm's tsc `user` CPU
  ~73% (≈31s→8s). But wall-clock stays high: the dominant cost is CPU contention from
  the two Vite dev servers + tsserver, NOT tsc work. First run after any source change
  is still full; only repeat runs are cheap. To verify fast, reduce contention (or just
  trust EXIT=0 + an empty error tail — tsc prints errors only at the end).

**`pnpm codegen` (orval):** also CPU-slow (~110s for a single target). If it won't
finish, generate per-target with temp single-target configs + `prettier:false`,
then run prettier separately (delete the temp configs after).

**Most reliable escape hatch — a Replit-managed WORKFLOW, not nohup/setsid.**
Under severe throttle, detached background jobs (`nohup`/`setsid`, even with
`</dev/null` + a completion sentinel) get SIGKILL-reaped after ~4 min — NOT an
OOM (mem + cpu-time are both unlimited here), but an external reaper of orphaned
processes, so the `; echo done` sentinel never fires (0-byte log, process gone).
Foreground bash dies at the ~120s cap. A configured workflow
(`configureWorkflow({name, command, outputType:"console", autoStart:true})`) is
Replit-managed and is NOT reaped — it runs to completion however long it takes.
Poll `getWorkflowStatus({name})` until `state` is `finished`/`failed`, read
`.output`, then `removeWorkflow`. This is how codegen, full `tsc`, the parity
script, and vitest were each run to completion. (`getWorkflowStatus` still
returns `.output` for a `finished` workflow, despite the skill's caveat.)

**Integration-test failures under throttle are TIMEOUTS, not assertions.** A full
vitest run with dozens of DB-backed files each booting `app.listen(0)` + sharing
the one dev DB shows a few "Test timed out in 5000ms" failures purely from
contention. Re-run the ONE suspect file in isolation with a raised hook budget
(`pnpm --filter <pkg> exec vitest run <file> --hookTimeout=240000 --testTimeout=60000`)
— the limiter is usually the `beforeAll` DB-setup hook (when IT times out every
test in the file SKIPs, not fails), and isolation removes cross-file contention.
Green-in-isolation confirms the suite failures were environmental, not a regression.
NOTE: `pnpm run test -- <filter>` forwards as `vitest run -- <filter>`; the stray
`--` swallows the positional filter so the WHOLE suite runs — use `exec vitest run
<file>` to actually target one file.
NOTE: when polling a backgrounded run, `pgrep -f "vitest run"` matches the polling
shell's OWN command line (it contains the string) → perpetual false "RUNNING" after
the real process was reaped. Check `ps` for an actual vitest/node PID, or better,
skip nohup entirely and use the workflow escape hatch above (the registered
`test-api` validation workflow runs the full suite to completion reliably).

**Running a real app function as a one-off (DB-touching verification):** do NOT
`npx tsx` a script that imports the full app graph (DB pool + pino workers) — cold
runtime TS compilation of the whole graph blows past the foreground cap and the
process gets reaped with NO output and no DB writes. Instead bundle it like the
server's own `build.mjs`: temporarily add your one-off entry to that file's
`entryPoints`, run `node build.mjs` (esbuild bundle, fast even at ~1-4mb), then
`node dist/<entry>.mjs`. A bundled `.mjs` cold-starts in seconds (no runtime tsc)
and shares the dev DB. Revert the `build.mjs` entry + delete the temp src/dist
files when done. This is how Stripe restricted-key data was verified end-to-end.

**e2e `runTest`:** can exceed the 600s `code_execution` hard cap purely from
throttling even WITH `testClerkAuth: true` (the SubagentSession child workflow
times out StartToClose). When that happens it is an ENVIRONMENT block, not a code
bug — don't keep retrying. Fall back to: full typecheck + unit suite + a static
read of the changed frontend wiring + clean workflow/browser-console logs.
