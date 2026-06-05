---
name: Orval query-key invalidation prefix
description: React Query invalidateQueries must use the "/api" prefix to match generated keys
---

Orval generates React Query keys namespaced under the full request path, e.g.
`["/api/staged-payments", params]`, `["/api/gifts-and-payments", params]`.

**Rule:** `queryClient.invalidateQueries({ queryKey: [...] })` does a *prefix*
match, so the prefix MUST include `/api`. Invalidating `["/staged-payments"]`
(no `/api`) silently matches nothing — the list never refetches and the UI looks
"stuck" after a mutation (e.g. staged-payments left column not refreshing after
exclude/match).

**Why:** the bug is invisible — no error, the mutation succeeds, but the cache is
never marked stale. Easy to write a hand-rolled prefix that drifts from the
generated key.

**How to apply:** prefer the generated `get<Op>QueryKey()` helpers for
invalidation. If you must hardcode a prefix, copy it from the generated
`get...QueryKey` (it starts with `/api/...`). Grep `queryKey: ["/` in a page to
spot prefixes missing `/api`.
