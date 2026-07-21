---
name: Router self-prefix + 401 masking
description: Reconciliation routers self-prefix their full path; requireAuth-before-routing makes curl 401 mask an unregistered route.
---

The reconciliation feature routers are mounted in `routes/index.ts` WITHOUT a path prefix — each route must self-prefix its full path (e.g. `"/reconciliation/workbench-clusters"`). A route registered with only `"/workbench-foo"` silently lives at `/api/workbench-foo` and the client's `/api/reconciliation/...` 404s.

**Why:** requireAuth is applied via `router.use` and runs before route matching, so an unauthenticated curl returns 401 whether or not the route exists — 401 does NOT prove registration. Verify registration with an authed request (integration test mocking requireAuth) or by checking for 404 vs 401 on the *authed* path.

**How to apply:** when adding a route to any reconciliation router, copy a sibling's full self-prefixed path; verify with the HTTP integration test pattern, not bare curl.
