---
name: QuickBooks full re-pull runs in the background
description: Why the QB full re-pull is fire-and-forget + polled instead of a synchronous request
---

# QuickBooks full re-pull is background + polled

The full re-pull (`fullResync: true`) walks the entire QuickBooks back-catalog and
takes **~4 minutes** (observed ~235s for ~3,235 entities). A synchronous request
that long is killed by the browser/proxy (~30–60s timeout), so the UI shows a
false "re-pull failed" **even though the server completes successfully** (200 with
`pulled=…` shows up in deployment logs minutes later).

**Rule:** any admin action that can exceed the proxy timeout must be kicked off in
the background and polled, never awaited inside the request.

**How it's wired:**
- Server keeps a **process-local** `FullResyncState` (`idle|running|done|error`)
  in `quickbooksSync.ts`. `startFullResync()` returns immediately and runs the job
  fire-and-forget; `getFullResyncState()` exposes progress. The real concurrency
  guard is still the advisory lock inside `syncQuickbooks`; the flag only drives
  the UI. Process restart mid-run resets state to `idle` and the poller stops.
- `POST /quickbooks/resync-full` → returns state immediately (no longer awaits).
  `GET /quickbooks/resync-status` → poll target.
- Frontend polls with React Query `refetchInterval` only while `status==='running'`
  and adopts an in-flight run on mount (reload / other admin tab).

**Why state is in-memory, not a DB column:** QB is a single shared company
connection, the job is rare/admin-triggered, and losing state on restart is
acceptable (poller stops cleanly). Don't over-engineer it into a table.
