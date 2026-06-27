---
name: QuickBooks/prod data lives in PROD, not dev
description: Why QBO lookups (payment dates, deposits, staged_payments) and some recently-changed records return empty in dev — query prod read-only instead.
---

# QuickBooks (and other live) data is in PRODUCTION, not the dev DB

The dev database is a **stale / partial** copy. Live operational data that is
populated by prod-only workers or human prod edits is **absent or out of date in
dev**. Do NOT conclude a record "doesn't exist" or "has no QuickBooks data" from a
dev query — check prod first.

Confirmed-empty-in-dev examples (all present in prod):
- **QuickBooks sync data** — `staged_payments` and the QB sync tables are populated
  by the prod QuickBooks worker. Stranahan (and other historical donors) have QBO
  payments/deposits in prod but **zero rows in dev**. So payment dates, deposit
  dates, and amounts that "come from QuickBooks" can only be looked up in prod.
- **Recently opened/closed/renamed records** — e.g. a school that opened then
  closed, or was renamed, may be in prod's `schools` (sourced from the Airtable
  "crm files" base import, PK = Airtable rec id) but missing from a stale dev DB.
- **`coding_form_rows`** — the one-time coding-form xlsx staging (incl. the
  `drive_link` grant-agreement links) is prod-only; dev has 0 rows with a link.
  Any feature that reads/backfills from those rows can only be exercised against
  prod, so the actual run is human-driven, not a dev e2e.

**How to apply:** for any "find the payment date / deposit / QBO fact" or
"verify a record exists" task, query **prod read-only** (database skill with
`environment: "production"`, or `$PROD_DATABASE_URL` for a read-only `psql`), not
dev. The agent still **cannot write** to prod — data changes ship as reviewed
idempotent SQL files in `lib/db/migrations/` applied by a human.

**Why:** repeatedly re-discovering "dev has no QuickBooks data" wastes a round-trip
with the user every time. The user explicitly asked to record this so we stop
having the same conversation.
