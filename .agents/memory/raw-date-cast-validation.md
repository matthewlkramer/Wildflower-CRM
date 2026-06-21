---
name: Raw ::date cast needs round-trip validation
description: Why query-param dates feeding a raw Postgres ::date cast must be validated with a Date round-trip, not just a regex, to avoid 500s.
---

When a route param flows into a raw `::date` cast inside a `sql` template (e.g.
the reconciliation date-window searches), validate it before building the query
or a malformed value raises a Postgres 500 instead of a clean 400.

**Why:** A format-only regex (`/^\d{4}-\d{2}-\d{2}$/`) still passes impossible
calendar dates like `2026-13-40`, which then blow up at the `::date` cast. The
contract advertises 400 for bad input, so the DB-500 path is a contract
violation, not just noise.

**How to apply:** Use a round-trip check —
`new Date(`${s}T00:00:00Z`)` must be valid AND `.toISOString().slice(0,10) === s`.
Return 400 on failure. Mirror the helper in every route that casts a query-param
date (currently `routes/reconciliation/{gifts-missing-qb,search}.ts`).
