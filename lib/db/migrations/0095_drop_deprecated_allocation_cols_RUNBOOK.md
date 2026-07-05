# Runbook — 0095 Drop the deprecated allocation restriction / coding-snapshot columns

## What this does

Physically drops the fully-deprecated Task #449 columns from **`gift_allocations`**
and **`pledge_allocations`** only. They were superseded by the three-axis
restriction taxonomy (`regional/usage/time_restriction_type`) and by moving the
revenue-coding snapshot onto `staged_payments`.

| Table | Dropped columns |
| --- | --- |
| `gift_allocations` | `formal_regional_restriction`, `formal_fund_use_restriction`, `restriction_type`, `restriction_evidence`, `deferred_revenue`, `deferred_revenue_reason`, `object_code`, `object_code_override`, `revenue_location`, `revenue_location_override`, `revenue_class`, `revenue_class_override`, `coding_flags` |
| `pledge_allocations` | `formally_restricted`, `restriction_type`, `restriction_evidence`, `deferred_revenue`, `deferred_revenue_reason`, `object_code`, `object_code_override`, `revenue_location`, `revenue_location_override`, `revenue_class`, `revenue_class_override`, `coding_flags` |

### ⚠️ Do NOT touch `staged_payments`

The identically-named coding columns on `staged_payments` (`object_code`,
`revenue_location`, `revenue_class`, `coding_flags`, `deferred_revenue`,
`deferred_revenue_reason`, …) are **LIVE** — read/written by
`reconciliation/cards.ts`, `quickbooks/actions.ts`, and the workbench coding form.
This migration is strictly the two allocation tables.

## Why it is safe (verified read-only)

- No app code reads or writes these columns on the allocation tables. They
  survived only in the Drizzle schema + the generated OpenAPI/Zod — all removed by
  this task's code.
- The single raw-SQL reader — `reconciliation/cards.ts`'s
  `resolvedGiftAllocations` subquery, which still read `ga.restriction_type` /
  `ga.formal_regional_restriction` / `ga.formal_fund_use_restriction` — was updated
  in the SAME task to read the live `regional/usage/time_restriction_type` columns
  instead (matching the OpenAPI `ReconciliationCardGiftAllocation` contract and the
  frontend, which already expected the three-axis fields). So AFTER this task's code
  is live, nothing references the dropped columns.
- No indexes, FKs, or enum types depend on these columns.
- **Enum types**: `deferred_revenue` STAYS (still used by
  `staged_payments.deferred_revenue`). `restriction_type` becomes orphaned but is
  intentionally left in place (low value; a later dedicated migration can retire it
  after re-confirming zero references).

## Pre-checks (re-run read-only against prod right before scheduling the drop)

```sql
-- Confirm the columns still exist in prod (so the DROP is meaningful, not a no-op):
SELECT table_name, column_name FROM information_schema.columns
WHERE table_name IN ('gift_allocations','pledge_allocations')
  AND column_name IN (
    'formal_regional_restriction','formal_fund_use_restriction','formally_restricted',
    'restriction_type','restriction_evidence','deferred_revenue','deferred_revenue_reason',
    'object_code','object_code_override','revenue_location','revenue_location_override',
    'revenue_class','revenue_class_override','coding_flags')
ORDER BY table_name, column_name;

-- Sanity: the live three-axis columns are present + populated (NOT NULL default):
SELECT count(*) FILTER (WHERE regional_restriction_type IS NULL) AS gift_null_axes
FROM gift_allocations;
SELECT count(*) FILTER (WHERE regional_restriction_type IS NULL) AS pledge_null_axes
FROM pledge_allocations;
```

## Deploy ordering (prod) — **Publish FIRST, then this SQL** (same as 0094)

The columns are no longer written, but the currently-deployed prod build still
**SELECTs** them (they remain in the Drizzle schema; `select()` /
`getTableColumns` emit every schema column, and the response is scrubbed only AFTER
the read). So:

1. **Publish this task's code first.** The new build removes the columns from the
   schema and stops selecting them. Publish diffs **dev-DB vs prod-DB** (not the
   schema source), and at this point **both DBs still hold all the columns**, so the
   diff is clean — Publish proposes no drop and deploys successfully.
2. **After the new code is live in prod**, apply this file to **prod**:
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0095_drop_deprecated_allocation_cols.sql
   ```
3. Apply the SAME file to **dev**:
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0095_drop_deprecated_allocation_cols.sql
   ```

`psql -1` wraps the file in ONE transaction — do not add `BEGIN`/`COMMIT` inside it.

Run steps 2 and 3 **back-to-back and do NOT Publish between them.** In the window
where prod has dropped the columns but dev still holds them, a Publish would see
**dev-only columns** and propose an ADDITIVE re-create of the dead columns on prod.

### ⚠️ Do NOT drop dev alone before Publish

If dev drops the columns while prod still has them, the next Publish sees a
**prod-only column** and proposes a **destructive prod DROP**, which aborts the whole
diff (additive changes skipped → 500 healthcheck → rollback). Keep dev and prod in
lockstep **through** Publish; only after Publish drop **both**.

### Note on the post-merge push

When this task merges, `post-merge.sh` runs interactive `drizzle-kit push` against
the **dev** DB. Because the schema dropped these columns but the dev DB still holds
them, push detects a data-loss DROP and **aborts** — expected and harmless for this
merge (it introduces **no additive** schema changes, so nothing is lost; the dev app
keeps serving with the columns as dead orphans). Once you have run step 3, dev
matches the schema again and post-merge push returns to a clean no-op. Do this
promptly so a later merge's additive changes aren't blocked by the same abort.

## Idempotency

`DROP COLUMN IF EXISTS` → safe to re-run; a second run is a no-op.

## Verify (read-only, after applying)

```sql
-- All dropped columns gone (expect ZERO rows):
SELECT table_name, column_name FROM information_schema.columns
WHERE (table_name = 'gift_allocations' AND column_name IN (
        'formal_regional_restriction','formal_fund_use_restriction',
        'restriction_type','restriction_evidence','deferred_revenue',
        'deferred_revenue_reason','object_code','object_code_override',
        'revenue_location','revenue_location_override','revenue_class',
        'revenue_class_override','coding_flags'))
   OR (table_name = 'pledge_allocations' AND column_name IN (
        'formally_restricted','restriction_type','restriction_evidence',
        'deferred_revenue','deferred_revenue_reason','object_code',
        'object_code_override','revenue_location','revenue_location_override',
        'revenue_class','revenue_class_override','coding_flags'));

-- staged_payments coding columns UNTOUCHED (expect all present):
SELECT column_name FROM information_schema.columns
WHERE table_name = 'staged_payments'
  AND column_name IN ('object_code','revenue_location','revenue_class',
                      'coding_flags','deferred_revenue','deferred_revenue_reason')
ORDER BY column_name;
```

## Rollback

Structure-only if ever needed: re-add the columns from the pre-drop DDL
(`boolean NOT NULL DEFAULT false` for the `formal_*` / `formally_restricted`
booleans; nullable `text` / `text[]` for the coding columns; the enum columns as
`restriction_type` / `deferred_revenue` typed). There is nothing to restore into
them — the authoritative signals live on the three-axis restriction columns and on
`staged_payments`.
