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

**`pnpm codegen` (orval):** also CPU-slow (~110s for a single target). If it won't
finish, generate per-target with temp single-target configs + `prettier:false`,
then run prettier separately (delete the temp configs after).

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
