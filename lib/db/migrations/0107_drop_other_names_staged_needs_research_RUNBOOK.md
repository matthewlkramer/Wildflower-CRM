# Runbook — 0107 Drop `organizations.other_names` and `staged_payments.needs_research`

## What this does

Physically drops two long-deprecated, fully-inert columns:

| Dropped | Superseded by |
| --- | --- |
| `organizations.other_names` | `organizations.historical_names` (migration 0099) — the org's prior/alternate names live there now |
| `staged_payments.needs_research` | the Cleanup Queue — the derived, read-only `flaggedForResearch` badge from an OPEN `cleanup_queue` row (`target_type='staged_payment'`, `reason_code='needs_research'`) |

Neither column has an index, FK, or enum dependency, so nothing else is auto-dropped.

## Why it is safe (verified read-only against the schema-removal build)

- **`other_names`** is not read or written by any deployed code. It was already
  excluded from the shared org response projection (destructured out *before* the
  SELECT was built, so no query names it) and removed from the entity-merge override
  field list. The only remaining textual references are the **stale Airtable importer**
  (`import-airtable.mjs` — a known follow-up that targets the OLD split model and is
  never run) and the **one-time** `migrate-organizations.ts` consolidation script
  (raw-SQL column strings; already run). Neither is on the serving path.
- **`needs_research`** was already stripped from EVERY staged-payment response
  projection (`stagedSelect` / `stagedReturnColumns` / `StagedReturnRow`) and is never
  written — the "flag for research" flow lives entirely in the Cleanup Queue.

The full `pnpm run typecheck` (which compiles `src/__tests__` too) is green with both
columns removed from the Drizzle schema — the authoritative "no residual reference"
gate for a column drop (a dev-runtime test cannot validate a prod drop, since the
non-destructive strategy keeps the column in dev through Publish).

## Deploy ordering (prod) — **Publish FIRST, then this SQL** (same as 0104/0105)

Both columns are ALREADY unselected by the deployed build, so a drop would not 500
reads either way. The binding constraint is the **Publish diff**: Publish compares the
**dev-DB against the prod-DB** (not the schema source).

1. **Publish this task's code first.** The new build removes both columns from the
   schema. At this point **both DBs still hold both columns**, so the diff is clean —
   Publish proposes no drop and deploys successfully.
2. **After the new code is live in prod**, apply this file to **prod**:
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0107_drop_other_names_staged_needs_research.sql
   ```
3. Apply the SAME file to **dev**:
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0107_drop_other_names_staged_needs_research.sql
   ```

`psql -1` wraps the file in ONE transaction — do not add `BEGIN`/`COMMIT` inside it.

Run steps 2 and 3 **back-to-back and do NOT Publish between them.** In the window
where prod has dropped the columns but dev still holds them, a Publish would see
**dev-only columns** and propose an ADDITIVE re-create of the dead columns.

### ⚠️ Do NOT drop dev alone before Publish

If dev drops the columns while prod still has them, the next Publish sees a
**prod-only column** and proposes a **destructive prod DROP**, which aborts the whole
diff (additive changes skipped → 500 healthcheck → rollback). Keep dev and prod in
lockstep **through** Publish; only after Publish drop **both**.

### Note on the post-merge push

When this task merges, `post-merge.sh` runs interactive `drizzle-kit push` against the
**dev** DB. Because the schema dropped these columns but the dev DB still holds them,
push detects a data-loss DROP and **aborts** — expected and harmless for this merge (it
introduces **no additive** schema changes, so nothing is lost; the dev app keeps
serving with the columns as dead orphans). Once you have run step 3, dev matches the
schema again and post-merge push returns to a clean no-op. Do this promptly so a later
merge's additive changes aren't blocked by the same abort.

## Idempotency

`DROP COLUMN IF EXISTS` → safe to re-run; a second run is a no-op.

## Verify (read-only, after applying)

```sql
-- Both columns gone (expect ZERO rows):
SELECT table_name, column_name FROM information_schema.columns
WHERE (table_name = 'organizations'   AND column_name = 'other_names')
   OR (table_name = 'staged_payments' AND column_name = 'needs_research');

-- Historical names still present on organizations (expect a non-zero count):
SELECT count(*) FROM organizations WHERE historical_names IS NOT NULL;

-- "Needs research" still lives in the Cleanup Queue:
SELECT count(*) FROM cleanup_queue
WHERE target_type = 'staged_payment' AND reason_code = 'needs_research';
```

## Rollback

Structure-only if ever needed: re-add the columns from the pre-drop DDL
(`other_names text`; `needs_research boolean NOT NULL DEFAULT false`). There is nothing
to restore into them — alternate org names live in `organizations.historical_names` and
"needs research" lives in the Cleanup Queue.
