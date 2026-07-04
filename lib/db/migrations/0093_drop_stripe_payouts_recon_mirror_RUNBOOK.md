# Runbook — 0093 Drop the orphaned `stripe_payouts` reconciliation-mirror columns

## What this does

Physically drops the **7 write-only legacy mirror columns** (and their index) from
`stripe_payouts`. The authoritative Stripe payout ↔ QuickBooks deposit settlement
lives in the `settlement_links` table; the payout's reconciliation status is
**derived on read** (`payoutStatusFromLink` / `payoutStatusLabelSql`). These columns
were the pre-`settlement_links` mirror and have been write-only orphans since the
read-flip. This task removed the last writes, and 0093 removes the columns:

| Dropped | Was |
| --- | --- |
| `qb_reconciliation_status` | legacy 7-value status enum (plain `text`, not a pg enum) |
| `proposed_qb_staged_payment_id` | FK → `staged_payments` |
| `matched_qb_staged_payment_id` | FK → `staged_payments` |
| `qb_conflict_staged_payment_id` | FK → `staged_payments` |
| `qb_conflict_gift_id` | FK → `gifts_and_payments` |
| `qb_reconciliation_confirmed_by_user_id` | FK → `users` |
| `qb_reconciliation_confirmed_at` | timestamp |
| `stripe_payouts_qb_reconciliation_status_idx` | index on `qb_reconciliation_status` |

**Not dropped:** `qb_supersede_status` — a different concern (the QB-lump supersede
audit), intentionally retained (and still response-scrubbed).

## Why it is safe

- **`settlement_links` is the sole authoritative home** for every payout↔deposit
  tie. Every reader was flipped onto it (`payoutStatusFromLink` /
  `payoutStatusLabelSql`) in a prior release, so these columns are unread; after
  this task's code deploys they are also unwritten.
- **Money-total-neutral.** These columns never fed a gift, a paid-amount
  derivation, or a goal SUM — that all flows through `gifts_and_payments` /
  `gift_allocations` / `payment_applications`, untouched here. Dropping them cannot
  move a counted dollar.
- **No enum type orphaned.** `qb_reconciliation_status` was a plain `text` column,
  so there is nothing else to clean up. Dropping the columns auto-removes their FK
  constraints and the dependent index.

## Deploy ordering (prod) — **Publish FIRST, then this SQL** (reverse of 0091)

These columns are still **written** by the currently-deployed prod build (the
legacy dual-write). 0091 dropped an object already unused by live code, so it went
"SQL first, then Publish." Here it is the opposite:

1. **Publish this task's code first.** The new build stops writing these columns.
   Publish diffs **dev-DB vs prod-DB** (not the schema source), and at this point
   **both DBs still hold all 7 columns**, so the diff is clean — Publish proposes no
   drop and deploys successfully. Drizzle selects by schema definition, so the new
   code ignores the still-present physical columns (nullable → INSERTs that omit
   them succeed).
2. **After the new code is live in prod**, apply this file to **prod** (drops the
   now-fully-dead columns — safe, nothing writes them):
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0093_drop_stripe_payouts_recon_mirror.sql
   ```
3. Apply the SAME file to **dev** (the dev app is on the merged code, which also no
   longer writes these columns):
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0093_drop_stripe_payouts_recon_mirror.sql
   ```

`psql -1` wraps the file in ONE transaction — do not add `BEGIN`/`COMMIT` inside it.

Run steps 2 and 3 **back-to-back and do NOT Publish between them.** In the window
where prod has dropped the columns but dev still holds them, a Publish would see
**dev-only columns** and propose an ADDITIVE re-create of the dead columns on prod —
which succeeds silently and undoes step 2.

### ⚠️ Do NOT drop dev alone before Publish

If dev drops the columns while prod still has them, the next Publish sees
**prod-only columns** and proposes a **destructive prod DROP**, which aborts the
whole diff (additive changes skipped → 500 healthcheck → rollback). Keep dev and
prod in lockstep **through** Publish; only after Publish drop **both**.

### Note on the post-merge push

When this task merges, `post-merge.sh` runs interactive `drizzle-kit push` against
the **dev** DB. Because the schema dropped these columns but the dev DB still holds
them, push detects a data-loss DROP and **aborts** — this is expected and harmless
for this merge (it introduces **no additive** schema changes, so nothing is lost;
the dev app keeps serving with the columns as dead orphans). Once you have run step
3 above, dev matches the schema again and post-merge push returns to a clean no-op.
Do this promptly so a later merge's additive changes aren't blocked by the same
data-loss abort.

## Idempotency

`DROP INDEX IF EXISTS` + `DROP COLUMN IF EXISTS` → safe to re-run; a second run is a
no-op.

## Verify (read-only, after applying)

```sql
-- All 7 columns gone (expect ZERO rows):
SELECT column_name FROM information_schema.columns
WHERE table_name = 'stripe_payouts'
  AND column_name IN (
    'qb_reconciliation_status','proposed_qb_staged_payment_id',
    'matched_qb_staged_payment_id','qb_conflict_staged_payment_id',
    'qb_conflict_gift_id','qb_reconciliation_confirmed_by_user_id',
    'qb_reconciliation_confirmed_at');

-- Index gone (expect NULL):
SELECT to_regclass('public.stripe_payouts_qb_reconciliation_status_idx');

-- qb_supersede_status untouched (expect one row):
SELECT column_name FROM information_schema.columns
WHERE table_name = 'stripe_payouts' AND column_name = 'qb_supersede_status';

-- settlement_links (the authoritative store) untouched:
SELECT lifecycle, count(*) FROM settlement_links GROUP BY 1 ORDER BY 1;
```

## Rollback

Structure-only if ever needed: re-add the columns/index from the pre-drop DDL. There
is nothing to restore into them — they were write-only orphans fully superseded by
`settlement_links`. Treat rollback as schema shape, not data recovery.
