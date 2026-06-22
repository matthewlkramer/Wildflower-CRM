---
name: parseOrBadRequest validates its 2nd arg directly
description: Route helper gotcha — pass req.body/req.query, never req; wrong call type-checks but always 400s
---

`parseOrBadRequest(schema, input, res)` runs `schema.safeParse(input)` on `input`
**as-is**. Every route must pass the already-extracted value — `req.body`
(POST/PATCH), `req.query` (GET), or `req.body ?? {}` for optional bodies — never
the whole `req`.

**Why:** the param is typed `input: unknown`, so passing `req` (the Express
request) compiles cleanly — `pnpm run typecheck` will NOT catch it. At runtime the
request object never matches the body schema, so the endpoint silently returns
`400 validation_error` for every call. This shipped once and was only caught by a
DB-backed HTTP integration test, not by typecheck.

**How to apply:** when adding a route, copy the calling convention from a
neighboring route (e.g. `parseOrBadRequest(CreateNoteBody, req.body, res)`); if a
new POST endpoint 400s on a body you believe is correct, check this first. A quick
`rg "parseOrBadRequest\(" routes/*.ts` shows the standard `req.body`/`req.query`
usage to match.
