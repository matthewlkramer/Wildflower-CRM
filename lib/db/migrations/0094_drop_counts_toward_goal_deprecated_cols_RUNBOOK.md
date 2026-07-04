# Runbook — 0094 Drop the deprecated `counts_toward_goal` / `sync_gap` columns

## What this does

Physically drops three fully-deprecated columns. "Counts toward goal" is now an
**allocation-level** fact on `gift_allocations.counts_toward_goal` (invariant #2 —
money scope lives on the child allocation rows); the header copy on
`gifts_and_payments` and the ingest copy on `staged_payments` are retired, along
with the never-shipped `staged_payments.sync_gap` annotation (added in 0074, no
API/UI).

| Dropped | Was |
| --- | --- |
| `gifts_and_payments.counts_toward_goal` | header flag, superseded by allocations |
| `staged_payments.counts_toward_goal` | ingest copy; mints now recompute onto the allocation |
| `staged_payments.sync_gap` | never-shipped annotation (0074) |

This is the deferred section-3 drop of migration 0080 (which added the allocation
column and ran the one-time backfill).

## Why it is safe (verified read-only, dev AND prod)

- 0080's header/staged → allocation backfill already ran in prod (all five
  staged→gift link paths). Every non-goal signal lives on the allocations.
- prod `gifts_and_payments.counts_toward_goal` = 790/790 **TRUE** (no header signal).
- prod `staged_payments.sync_gap` = 3251/3251 **FALSE** (never held data).
- **Un-propagated = 0** in dev and prod: no gift header=false with an allocation
  still true; no staged=false whose linked gift still has a counting allocation
  (created/matched/group_reconciled + `staged_payment_splits` + `payment_applications`).
- **No stranded pending signal**: every un-minted staged `false` row has a `"CSP"`
  payer (non-CSP count = 0 in dev and prod), so its eventual mint recomputes the
  non-goal flag onto the allocation from `isGovernmentReimbursement` — the staged
  column is vestigial.
- **Money-total-neutral**: goal/received SUMs read only
  `gift_allocations.counts_toward_goal`. Dropping these cannot move a counted dollar.
- No indexes, FKs, or enum types depend on these plain boolean columns.

## Pre-checks (re-run read-only against prod right before scheduling the drop)

```sql
-- expect header 100% true:
SELECT counts_toward_goal, count(*) FROM gifts_and_payments WHERE archived_at IS NULL GROUP BY 1;
-- expect sync_gap 100% false:
SELECT sync_gap, count(*) FROM staged_payments GROUP BY 1;
-- expect 0: any un-minted staged=false row with a non-CSP payer
SELECT count(*) FROM staged_payments sp
WHERE sp.counts_toward_goal = false
  AND sp.created_gift_id IS NULL AND sp.matched_gift_id IS NULL
  AND sp.group_reconciled_gift_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM staged_payment_splits s WHERE s.staged_payment_id = sp.id)
  AND NOT EXISTS (SELECT 1 FROM payment_applications pa WHERE pa.payment_id = sp.id)
  AND lower(btrim(coalesce(sp.payer_name,''))) <> 'csp';
```

## Deploy ordering (prod) — **Publish FIRST, then this SQL** (same as 0093)

The columns are no longer written, but the currently-deployed prod build still
**SELECTs** them (they remain in the Drizzle schema; `select()` / `getTableColumns`
emit every schema column, and the response is scrubbed only AFTER the read). So:

1. **Publish this task's code first.** The new build removes the columns from the
   schema and stops selecting them. Publish diffs **dev-DB vs prod-DB** (not the
   schema source), and at this point **both DBs still hold all three columns**, so
   the diff is clean — Publish proposes no drop and deploys successfully.
2. **After the new code is live in prod**, apply this file to **prod**:
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0094_drop_counts_toward_goal_deprecated_cols.sql
   ```
3. Apply the SAME file to **dev**:
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0094_drop_counts_toward_goal_deprecated_cols.sql
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
-- All three columns gone (expect ZERO rows):
SELECT table_name, column_name FROM information_schema.columns
WHERE (table_name = 'gifts_and_payments' AND column_name = 'counts_toward_goal')
   OR (table_name = 'staged_payments'    AND column_name IN ('counts_toward_goal','sync_gap'));

-- Authoritative allocation flag untouched:
SELECT counts_toward_goal, count(*) FROM gift_allocations GROUP BY 1 ORDER BY 1;
```

## Rollback

Structure-only if ever needed: re-add the columns from the pre-drop DDL
(`boolean NOT NULL DEFAULT true` for the two counts-toward-goal columns,
`boolean NOT NULL DEFAULT false` for `sync_gap`). There is nothing to restore into
them — the authoritative signal lives on `gift_allocations`.
