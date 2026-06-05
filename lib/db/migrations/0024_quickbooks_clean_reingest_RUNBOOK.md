# Runbook — 0024 QuickBooks clean re-ingestion

One-time operation to reset the QuickBooks staged-payment queue and re-pull the
full QB history cleanly. Apply `0024_quickbooks_clean_reingest.sql` to
**production** by hand, then trigger a sync from the app.

## Why

The `staged_payments` table holds pre-rewrite rows — whole bank Deposits staged
before per-line splitting / `LinkedTxn` dedupe / `pg_trgm` scoring existed
(e.g. ~926 lump deposits with no payer or line detail). The incremental,
watermark-based sync never re-pulls that back-catalog, so those rows bury the
real per-donor payments and never auto-apply.

## What it does

- `DELETE FROM staged_payments` — wipes every staged row (resolved + unresolved).
- Resets `quickbooks_connections.sync_watermark` (and `last_synced_at`,
  `last_error`) to `NULL` so the next sync pulls the full history.

It does **not** touch `gifts_and_payments` or `gift_allocations`.

> **Keep the wipe and the watermark reset together.** Deposit-derived coding
> (account / class / memo) is folded onto a Payment/SalesReceipt from the deposit
> that re-records it, and the upsert preserves already-stored coding on a
> re-sync rather than re-deriving it from older, out-of-window deposits. So the
> only way a row gets its full coding is the *first* pull that sees both it and
> its deposit. Resetting the watermark to `NULL` forces that first pull to be the
> full history. Never `DELETE FROM staged_payments` (or otherwise reseed rows)
> without also resetting the watermark — a "first-seen" row inserted under an
> advanced watermark can miss an older deposit's coding.

## Pre-checks (read-only)

```sql
-- Current queue volume + the gifts that must survive untouched.
SELECT status, count(*) FROM staged_payments GROUP BY 1 ORDER BY 1;

SELECT g.id, g.amount, g.date_received,
       (SELECT count(*) FROM gift_allocations a WHERE a.gift_id = g.id) AS allocations
FROM gifts_and_payments g
WHERE g.id IN (SELECT created_gift_id FROM staged_payments WHERE created_gift_id IS NOT NULL);
```

Note the gift IDs returned — those are the QB-auto-created gifts (each has an
allocation). They are preserved by this migration and must still exist, with
their allocations, after the re-sync.

## Apply

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0024_quickbooks_clean_reingest.sql
```

Idempotent — safe to re-run (the second run deletes nothing and just re-resets
the watermark).

## Then: re-pull from the app

1. Open **QuickBooks Reconciliation** in the published app.
2. Click **Sync now** (admin). The first run pulls the full history, so it can
   take a while; if it reports "already in progress", wait and re-check.
3. The sync stages per-line deposits (skipping deposit lines linked to an
   already-ingested Payment/SalesReceipt), classifies non-gifts, scores matches,
   and auto-applies high-confidence ones into the **Auto-matched** queue.

## Post-sync verification (read-only)

```sql
-- Auto-matched queue is now populated.
SELECT count(*) AS auto_matched
FROM staged_payments
WHERE status='approved' AND auto_applied=true AND match_confirmed_at IS NULL;

-- Real payments now present in the review queue (not only deposits).
SELECT qb_entity_type, count(*)
FROM staged_payments WHERE status='pending' GROUP BY 1 ORDER BY 1;

-- The pre-existing QB gifts were RECONCILED (linked), not duplicated.
-- Each surviving gift id should be referenced by exactly one staged row via
-- matched_gift_id, and there should be no second gift with the same
-- donor/amount/date.
SELECT matched_gift_id, count(*)
FROM staged_payments
WHERE matched_gift_id IS NOT NULL
GROUP BY 1 HAVING count(*) > 1;     -- expect 0 rows

-- Direct duplicate sweep: no two gifts share the same donor + amount + date.
-- (Catches the rare case where the matcher minted a new gift instead of
-- reconciling to a preserved one.) Expect 0 rows.
SELECT amount, date_received,
       organization_id, individual_giver_person_id, household_id,
       count(*)
FROM gifts_and_payments
GROUP BY amount, date_received, organization_id,
         individual_giver_person_id, household_id
HAVING count(*) > 1;
```

If any of the 6 preserved gifts shows up duplicated (a new minted gift with the
same donor/amount/date alongside the original), reject the duplicate staged row
in the UI — there are only a handful and they are easy to eyeball.

## Rollback

There is no automated rollback (rows are intentionally deleted). To recover the
prior queue state, restore from the most recent database checkpoint/backup taken
before applying this file.
