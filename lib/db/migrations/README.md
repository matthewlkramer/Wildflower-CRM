# Migration numbering rule

Before adding a new migration file, check the highest sequence number already
used in this directory (`ls lib/db/migrations | sort | tail`) and take the next
free number. Duplicate prefixes make it easy to skip or double-apply a file and
let dev and prod diverge silently.

- Never rename a migration that has already been applied to production —
  renumber only not-yet-applied duplicates.
- Files are hand-applied idempotent psql scripts; see each file's header (or
  its `*_RUNBOOK.md`) for the exact `psql "$PROD_DATABASE_URL" -1 -v
  ON_ERROR_STOP=1 -f lib/db/migrations/<file>.sql` command.

Historical note (2026-07-20): three files briefly shared the `0140` prefix.
All three were already fully applied (and idempotent no-ops) in prod, so two
were renumbered for uniqueness: `0140_add_coding_form_row_overrides.sql` →
`0142_...` and `0140_drop_gift_header_columns.sql` → `0143_...`;
`0140_fundraising_campaigns.sql` (the earliest) kept its number. Older
duplicate prefixes (e.g. the three `0130` files) predate this rule and remain
untouched because they are applied history.
