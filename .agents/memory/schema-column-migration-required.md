---
name: Additive schema columns need a migration file
description: New Drizzle columns require a reviewable idempotent migration SQL file, not Publish alone.
---

Adding a column to a Drizzle schema in this repo is NOT complete with just the
schema edit + `push` to dev. Ship a reviewable idempotent migration file in
`lib/db/migrations/` (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`) plus a
`_RUNBOOK.md`, following existing additive-column precedent (0002b_add_loss_type,
0006_fundable_project_planning_fields, 0017_quickbooks_customer_id_columns).

**Why:** The code-review validation gate REJECTS a schema change with no
corresponding migration file ("column does not exist at runtime" risk), even
though Publish's Drizzle diff also creates additive columns in prod. Two things
are both true here and it's easy to trip on: additive columns DO propagate via
Publish AND the repo convention/reviewer still expects the explicit reviewable
SQL artifact. Don't over-index on the "Publish handles columns" memory notes and
skip the file.

**How to apply:** Whenever you add a column, in the same task create
`lib/db/migrations/NNNN_<name>.sql` (idempotent, NOT NULL DEFAULT constants are
metadata-only on PG11+, nullable text is metadata-only) + runbook, apply it to
dev to prove it's a clean no-op, and reference `$PROD_DATABASE_URL` + the
repo-root-relative path in the runbook (user preference). Publish + the file are
order-independent because of `IF NOT EXISTS`.
