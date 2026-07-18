---
name: prod executeSql enum-column silent empty result
description: Production read-only executeSql returns no rows (only START TRANSACTION/ROLLBACK, success=true) when the SELECT list touches an enum column without ::text cast.
---

The rule: when querying prod via `executeSql({environment: "production"})`,
cast every enum-typed column in the SELECT list (and anything compared
against text CASE arms) to `::text`.

**Why:** A query selecting `gifts_and_payments.quickbooks_tie_status` (enum
`gift_quickbooks_tie`) raw returned `success: true` with output containing
only `START TRANSACTION` / `ROLLBACK` and zero rows — no error surfaced.
Adding `::text` made the identical query return rows. The read-only wrapper
apparently fails row serialization for unknown enum OIDs and swallows the
failure.

**How to apply:** If a prod read returns only transaction markers with no
rows and no error, suspect an un-cast enum (or other custom type) in the
result set before suspecting the data. Dev-side psql does not have this
problem.

**Same silent-empty symptom, second cause:** referencing a NONEXISTENT
column also returns only `START TRANSACTION`/`ROLLBACK` with
`success: true` — the query error is swallowed exactly like the enum
case (hit 2026-07: `staged_payments.txn_date` does not exist; the column
is `date_received`). So a silent empty result means either an un-cast
custom type OR a typo'd/renamed column; verify column names against
`lib/db/src/schema/` before trusting "no rows".
