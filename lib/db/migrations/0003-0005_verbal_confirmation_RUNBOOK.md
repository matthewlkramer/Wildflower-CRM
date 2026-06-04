# Runbook: verbal_commitment → verbal_confirmation (Task #159)

Renames the opportunity stage `verbal_commitment` → `verbal_confirmation` and
reclassifies it from a **pledge** to an **opportunity**. Production now holds
live data and the agent cannot write to prod, so every prod data change ships as
the reviewed, idempotent SQL files below.

## What changes

- The stored enum value `verbal_commitment` becomes `verbal_confirmation`
  (user-facing label "Verbal confirmation" comes from the frontend).
- Verbal confirmation derives `status = open` and never sets the sticky
  `was_pledge` flag, so it shows on **Opportunities**, not **Pledges**.
- `written_commitment` and `conditional_commitment` / grant-letter rows stay
  pledges. Verbal's win probability stays `0.9000`.

## Apply order (production)

Run in order, each in its own transaction. Stop on first error.

| Step | File | When |
| ---- | ---- | ---- |
| 1 | `0003_rename_verbal_confirmation.sql` | **Before / at** deploying the new code (the new code references `verbal_confirmation`). |
| 2 | `0004_reclassify_verbal_confirmation.sql` | After step 1. Requires Task #158's `loss_type` column + calculated status. |
| 3 | `0005_saved_views_verbal_confirmation.sql` | Alongside step 1 (before or after step 2). |

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0003_rename_verbal_confirmation.sql
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0004_reclassify_verbal_confirmation.sql
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0005_saved_views_verbal_confirmation.sql
```

All three are idempotent (guarded rename, `was_pledge = true` predicate clears
itself, literal-rewrite only matches rows still holding the old value), so a
re-run is a safe no-op.

## Pre-flight check (read-only)

```sql
-- rows that will be reclassified (was_pledge cleared, status re-derived):
SELECT id, status, loss_type, was_pledge, win_probability, grant_letter_url
FROM opportunities_and_pledges
WHERE stage = 'verbal_confirmation'      -- pre-rename: stage = 'verbal_commitment'
  AND was_pledge = true
  AND grant_letter_url IS NULL
  AND NOT EXISTS (SELECT 1 FROM gifts_and_payments g WHERE g.payment_on_pledge_id = id);

-- saved views still referencing the old value:
SELECT id, list_key, name FROM saved_views WHERE state::text LIKE '%verbal_commitment%';
```

## Post-apply verification

```sql
-- no old enum label remains:
SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'opportunity_stage' AND e.enumlabel = 'verbal_commitment';  -- 0 rows

-- no verbal row is still flagged a pledge for a non-independent reason:
SELECT id FROM opportunities_and_pledges
WHERE stage = 'verbal_confirmation' AND was_pledge = true
  AND grant_letter_url IS NULL
  AND NOT EXISTS (SELECT 1 FROM gifts_and_payments g WHERE g.payment_on_pledge_id = id);  -- 0 rows

-- no saved view references the old value:
SELECT id FROM saved_views WHERE state::text LIKE '%verbal_commitment%';  -- 0 rows
```
