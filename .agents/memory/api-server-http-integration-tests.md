---
name: api-server HTTP integration tests
description: How to write a DB-backed route test that boots the real Express app, when most of the suite is DB-free.
---

# DB-backed HTTP integration tests in api-server

Most of `artifacts/api-server/src/__tests__/` is pure-function or compiled-SQL
(`.toSQL()`) with a DUMMY `DATABASE_URL` — they never open a connection. When a
task needs to assert real DB state transitions through a route (e.g. QuickBooks
deposit multi-match / revert), write a live integration test instead.

**Pattern** (see `quickbooks-multi-match.integration.test.ts`):
- Mock ONLY the Clerk gate: `vi.mock("../middlewares/requireAuth", ...)` to set
  `req.appUser = { id }` and call `next()`. Use `vi.hoisted` for the user id used
  inside the mock factory. Seed a real `users` row with that id (FK target for
  `match_confirmed_by_user_id` / `approved_by_user_id`).
- `const { default: app } = await import("../app")`, then `app.listen(0)` and hit
  it with global `fetch`. `clerkMiddleware()` runs harmlessly without a session.
- Raise hook timeouts: app import + first DB connect easily exceeds the default
  10s `beforeAll` / 5s test timeout. Use `beforeAll(fn, 60_000)` and per-`it`
  `(…, 30_000)`.
- Guard with `describe.skipIf(!HAS_DB)` where `HAS_DB` rejects the dummy URL, so
  the file is a no-op in DB-less envs.
- Seed with a unique run prefix (`Date.now()`) and clean up in `afterAll`
  children-first (staged_payments → gift → org → user).

**Why:** the suite's no-DB convention can't cover route-level column writes; this
seam lets you test the genuine handler (transactions, locking, fee-band math,
partial-unique index) without standing up Clerk auth or supertest.
