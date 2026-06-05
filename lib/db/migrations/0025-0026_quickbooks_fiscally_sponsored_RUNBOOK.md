# Runbook — 0025/0026: exclude fiscally sponsored project payments

## What this does

Adds a `fiscally_sponsored` auto-exclude reason to the QuickBooks review queue and
backfills it over the existing queue. Money belonging to a **separate fiscally
sponsored project** (today: **"Embracing Equity"**) is removed from the left
column (the "Needs review" / pending queue) and lands in **Excluded** so it never
has to be reconciled.

This is a **project-identity** rule: it fires whenever the project marker appears
anywhere on a staged row — the QuickBooks **Class** (where fiscally sponsored
projects are normally tracked), the payer, the line item / account names, the line
description, or the memo. Because the whole payment belongs to the other project,
the rule deliberately fires **even on rows that carry a donation line** (no
donation-first guard).

The marker list is code-owned: `FISCALLY_SPONSORED_PROJECT_SUBSTRINGS` in
`artifacts/api-server/src/lib/quickbooksExclusionRules.ts` (currently the single
case-insensitive substring `embracing equity`). The SQL backfill in `0026` mirrors
it exactly — **keep them in lockstep**.

## Order of operations (production)

1. **Ship the code** (Publish). The classifier now reads the QuickBooks Class
   (`line_classes`) and auto-excludes future Embracing Equity payments on every
   sync.
2. **Add the enum value** — run WITHOUT `-1`:
   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0025_quickbooks_fiscally_sponsored_enum.sql
   ```
3. **Re-pull so line detail is populated.** The Class marker needs line detail on
   the staged rows. Trigger Settings → QuickBooks → "Sync now" (or wait for the
   scheduler). If historical rows pre-date per-line Class capture, a clean
   re-ingest may be needed (see `0024_quickbooks_clean_reingest_RUNBOOK.md`).
4. **Backfill the existing queue** — run WITH `-1`:
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0026_quickbooks_fiscally_sponsored_backfill.sql
   ```
   (Equivalently, an admin can hit the in-app **Reclassify** action, which re-runs
   the classifier over `auto` + `pending`/`excluded` rows.)

## Verify

```sql
SELECT status, exclusion_reason, count(*)
FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;
```

You should see a `excluded / fiscally_sponsored` bucket. Spot-check that the
excluded rows really carry the Embracing Equity marker:

```sql
SELECT id, payer_name, line_classes, line_item_names, raw_reference
FROM staged_payments
WHERE status = 'excluded' AND exclusion_reason = 'fiscally_sponsored'
LIMIT 20;
```

## Safety

- **Idempotent.** `0025` uses `ADD VALUE IF NOT EXISTS`; `0026` only ever moves
  `pending` → `excluded`, so re-running is a no-op and approved / rejected /
  re-included rows are never touched.
- **Nothing is deleted.** Excluded rows stay in the table for audit and can be
  re-included from the UI.

## Already-approved rows (manual decision)

If an Embracing Equity payment was **auto-matched/approved into a gift** before
this rule existed, neither `0026` (filters `status = 'pending'`) nor the in-app
Reclassify (skips approved rows) will touch it. Find them with:

```sql
SELECT id, status, created_gift_id, payer_name, line_classes
FROM staged_payments
WHERE status = 'approved'
  AND (
       lower(coalesce(payer_name,''))       LIKE '%embracing equity%'
    OR lower(coalesce(raw_reference,''))    LIKE '%embracing equity%'
    OR lower(coalesce(line_description,'')) LIKE '%embracing equity%'
    OR EXISTS (SELECT 1 FROM unnest(coalesce(line_classes,'{}'::text[])) c
                WHERE lower(c) LIKE '%embracing equity%')
    OR EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names,'{}'::text[])) li
                WHERE lower(li) LIKE '%embracing equity%')
    OR EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names,'{}'::text[])) a
                WHERE lower(a) LIKE '%embracing equity%')
  );
```

Decide per row whether to reject the staged payment and unwind its
`gifts_and_payments` row — do this through the app's reject flow, not raw SQL, so
the gift is removed consistently.
