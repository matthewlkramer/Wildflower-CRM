# Runbook — 0115 Drop `staged_payment_splits`

## What this does

Physically drops the **now-dead legacy split table**. A "split" (one QuickBooks
staged payment booked across multiple existing gifts) is now stored **only** in
the `payment_applications` cash-application ledger: one counted QB ledger row
per gift (`evidence_source = 'quickbooks'`, `link_role = 'counted'`) anchored to
the staged payment, with all three gift-link columns (`matched_gift_id` /
`created_gift_id` / `group_reconciled_gift_id`) left NULL on the staged row.

Every read that used to consult `staged_payment_splits` — the live-queue
"resolved" predicate, revert, gift combine/merge guards, the audit-reconciliation
`linkType`, split totals/names — was flipped onto counted ledger rows in this
task's code, and the split route's dual-write into the table was removed. The
table is fully dead: unread and unwritten by the new build.

| Dropped | Was |
| --- | --- |
| `staged_payment_splits` (whole table) | one row per split-member gift link (`staged_payment_id`, `gift_id`, `sub_amount`), dual-written alongside the ledger |

**Not dropped:** the `staged_payment_exclusion_reason` enum values
`processor_payout` and `confirmed_excluded` — still read by the revert paths.

## Why it is safe

- **`payment_applications` is the sole authoritative home** for split links.
  Every split written since the ledger shipped was dual-written (one counted QB
  ledger row per split row), and money reads already flow exclusively through
  counted ledger rows.
- **Guarded drop.** The SQL file opens with a `DO` block that **aborts the whole
  transaction** if ANY surviving `staged_payment_splits` row lacks its matching
  counted QB ledger row (`payment_id` + `gift_id` + `evidence_source =
  'quickbooks'` + `link_role = 'counted'`). A drop can never orphan a booked
  dollar — if the guard trips, the table is left fully intact.
- **Money-total-neutral.** Split sub-amounts feed reads via
  `payment_applications.amount_applied` (untouched here). Nothing in gift,
  paid-amount, or goal derivations reads the dropped table.

## Deploy ordering (prod) — **Publish FIRST, then this SQL**

`staged_payment_splits` is still **written** by the currently-deployed prod build
(the dual-write). Dropping it before the new code deploys would 500 every split
call. So:

1. **Publish this task's code first.** The new build neither reads nor writes
   the table. Publish diffs **dev-DB vs prod-DB** (not the schema source), and at
   this point **both DBs still hold the table**, so the diff is clean — Publish
   proposes no drop and deploys successfully.
2. **After the new code is live in prod**, apply this file to **prod**:
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0115_drop_staged_payment_splits.sql
   ```
   Watch for the `Guard passed` NOTICE. If it instead ABORTs with an orphan
   count, **stop** — some split row was never mirrored into the ledger. Inspect
   with:
   ```sql
   SELECT s.* FROM staged_payment_splits s
   WHERE NOT EXISTS (
     SELECT 1 FROM payment_applications pa
     WHERE pa.payment_id = s.staged_payment_id
       AND pa.gift_id = s.gift_id
       AND pa.evidence_source = 'quickbooks'
       AND pa.link_role = 'counted'
   );
   ```
   and backfill the missing counted rows before re-running the file.
3. Apply the SAME file to **dev** (the dev app is on the merged code, which also
   no longer touches the table):
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0115_drop_staged_payment_splits.sql
   ```

`psql -1` wraps the file in ONE transaction — do not add `BEGIN`/`COMMIT` inside
it.

Run steps 2 and 3 **back-to-back and do NOT Publish between them.** In the window
where prod has dropped the table but dev still holds it, a Publish would see a
**dev-only table** and propose an ADDITIVE re-create of the dead table on prod —
which succeeds silently and undoes step 2.

### ⚠️ Do NOT drop dev alone before Publish

If dev drops the table while prod still has it, the next Publish sees a
**prod-only table** and proposes a **destructive prod DROP**, which aborts the
whole diff (additive changes skipped → 500 healthcheck → rollback). Keep dev and
prod in lockstep **through** Publish; only after Publish drop **both**.

### Note on the post-merge push

When this task merges, `post-merge.sh` runs interactive `drizzle-kit push`
against the **dev** DB. Because the schema removed this table but the dev DB
still holds it, push detects a data-loss DROP and **aborts** — this is expected
and harmless for this merge (it introduces **no additive** schema changes, so
nothing is lost; the dev app keeps serving with the table as a dead orphan).
Once you have run step 3 above, dev matches the schema again and post-merge push
returns to a clean no-op. Do this promptly so a later merge's additive changes
aren't blocked by the same data-loss abort.

## Idempotency

The guard `DO` block short-circuits with a NOTICE when the table is already
gone, and `DROP TABLE IF EXISTS` makes a second run a no-op.

## Verify (read-only, after applying)

```sql
-- Table gone (expect NULL):
SELECT to_regclass('public.staged_payment_splits');

-- The authoritative store untouched: counted QB ledger rows still present
-- (same count as before the drop):
SELECT count(*) FROM payment_applications
WHERE evidence_source = 'quickbooks' AND link_role = 'counted';

-- Split-resolved staged rows (3 gift-link cols NULL + counted ledger rows)
-- still resolve out of the live queue (expect > 0 if prod has splits):
SELECT count(DISTINCT sp.id)
FROM staged_payments sp
JOIN payment_applications pa
  ON pa.payment_id = sp.id
 AND pa.evidence_source = 'quickbooks'
 AND pa.link_role = 'counted'
WHERE sp.matched_gift_id IS NULL
  AND sp.created_gift_id IS NULL
  AND sp.group_reconciled_gift_id IS NULL;
```

## Rollback

Structure-only if ever needed: re-create the table from the pre-drop DDL. There
is nothing to restore into it — split links are fully superseded by counted
`payment_applications` rows (which also carry the sub-amounts as
`amount_applied`). Treat rollback as schema shape, not data recovery.
