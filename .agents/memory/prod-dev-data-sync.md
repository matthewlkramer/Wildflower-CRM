---
name: prod→dev data sync (Copper-replacement CRM)
description: How to mirror fresher production row DATA into the dev DB safely, and the executeSql/notebook gotchas that bite during it.
---

# Prod → dev data sync

Goal pattern: pull fresher prod row data into dev WITHOUT clobbering intentional dev-side edits, excluding per-env tables.

## What to exclude
Per-environment tables that sync themselves per env — never copy prod→dev: email_*, calendar_*, media_*, google_oauth_tokens, tracked_email*, bulk_operations, users, interactions, meeting_notes, person_suppression_windows, correspondent_ignore. The ~22 "real CRM" tables (funders, people, orgs, households, opps, gifts, allocations, notes, tasks, addresses, phones, emails, roles, regions, schools, fiscal_years, etc.) are the INCLUDE set.

## Non-obvious data hazard: dev-side enrichment ties
`funders.about` has a dev-only enrichment (". Founded in YYYY." appended). On rows where prod & dev have EQUAL `updated_at` ("tie"), prod's about is the un-enriched older text — writing it REVERTS the dev work. Rule: on ties, prefer dev; only take prod when prod genuinely changed (updated_at newer). Classify every changed cell prod_newer / dev_newer / tie before applying; do not blindly take prod.

## executeSql / notebook gotchas (these cost the most time)
- **Output size cap.** `funders` rows have large `about`/`details`; `json_agg(row_to_json())` over even small batches overflows and returns an EXECUTE_SQL error or unparseable output. Fix: fetch big text columns separately — pull base columns in bulk, then `id,about,details` in small adaptive batches, and isolate giant rows (`length(about)+length(details) > N`) via per-column `to_json(col)`.
- **Empty aggregate vs oversized.** `json_agg` over 0 rows returns SQL NULL (renders as an empty cell), which is NOT an error. Distinguish it from oversized/ROLLBACK output or you'll retry-then-throw on legitimately-empty queries.
- **The code_execution notebook can reset mid-task**, wiping ALL in-memory state. Persist anything expensive (diff results, apply payload) to disk under `.local/` so a reset doesn't force a full recompute.
- Each executeSql call is its own session/transaction.

## Apply mechanism that works
- Reconstruct typed values cheaply from the approved CSV + `information_schema.columns.data_type` (text/timestamp/enum → string; ARRAY/json → JSON.parse; boolean/number → coerce; `"NULL"` token → null). CSV text columns are lossless, so no giant prod re-fetch is needed at apply time.
- Writes: `INSERT ... SELECT cols FROM json_populate_recordset(NULL::tbl, $j$[...]$j$)` for new rows; per-row `UPDATE t SET col=s.col FROM json_populate_record(NULL::tbl, $j${...}$j$) s WHERE t.id=s.id` for changed cells. Dollar-quote the JSON. json_populate_* handles all column typing (text[], timestamps, enums) automatically.
- Wrap the whole batch with `SET session_replication_role=replica; ... SET session_replication_role=DEFAULT;` to bypass FK ordering (confirmed works on dev). It's atomic in one executeSql call.
- **Because replica bypasses FK, manually verify INCLUDE→EXCLUDE FKs first** (esp. `*.owner_user_id`/`author_user_id`/`assignee_user_id` → users) — the referenced user/parent ids must already exist in dev, else you silently create dangling refs.
- Never delete dev-only rows (rows present in dev, absent in prod) — they're intentional.

**Why:** prod executeSql is READ-ONLY; prod schema/data changes only go through the Publish flow. Dev is recoverable via checkpoints, so dev is where syncs land.
