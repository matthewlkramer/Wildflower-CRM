# Runbook — Migration 0146: drop transitional gift/org columns + dead review table (Task #757)

## What it does

One idempotent file, three steps, applied in a single transaction (`-1`):

1. **Backfill** — any remaining non-null `organizations.payment_intermediary_id`
   is inserted into `donor_payment_intermediaries` (deterministic
   `dpibf_<orgId>` ids, `ON CONFLICT DO NOTHING`, skips dangling intermediary
   FKs via the JOIN). Skipped entirely if the column is already dropped.
2. **Drop columns** — `organizations.payment_intermediary_id` (+ its index),
   `gifts_and_payments.final_amount_source`, and
   `gifts_and_payments.original_human_crm_amount`.
3. **Drop the dead review table, then its enum** —
   `gift_amount_allocation_review` (with its indexes/FKs), then
   `DROP TYPE gift_final_amount_source`. The table was the worklist of the
   stamp/unstamp final-amount flow retired in Task #757: no OpenAPI path, no
   frontend reference, no server route reads it; its only writer's only caller
   was an integration test. It was the enum's last dependent, so it must drop
   BEFORE the type.

**History:** the FIRST prod apply of this file failed at
`DROP TYPE gift_final_amount_source` (the review table still depended on it).
The `-1` transaction rolled back **atomically**, so prod was left completely
unchanged (verified 2026-07-21: all three columns still present). The file was
then amended in place to drop the table ahead of the enum; it was never applied
anywhere, so in-place amendment is safe.

Row-count evidence (re-verify at apply time, do not trust these snapshots
blindly): prod `gift_amount_allocation_review` held **0** rows
(verified 2026-07-21); dev held **28** stale OPEN rows — transient worklist
debris created by the retired flow, safe to drop. Dev had **0** rows with a
non-null org `payment_intermediary_id`, so the dev backfill is a no-op.

## Preconditions

- The api-server build from Task #757 is **deployed** (Publish done). The
  deployed code has no reads/writes/echoes of any of the three columns.

## Verify before (prod)

```sql
-- How many org links will be backfilled?
SELECT count(*) FROM organizations WHERE payment_intermediary_id IS NOT NULL;
-- Of those, how many already have a dpi row (will be no-ops)?
SELECT count(*) FROM organizations o
JOIN donor_payment_intermediaries d
  ON d.organization_id = o.id
 AND d.payment_intermediary_id = o.payment_intermediary_id
WHERE o.payment_intermediary_id IS NOT NULL;
-- Review-table rows about to be dropped (prod verified 0 total on 2026-07-21;
-- dev's 28 open rows are stale debris from the retired flow):
SELECT count(*) AS total,
       count(*) FILTER (WHERE resolved_at IS NULL) AS open
FROM gift_amount_allocation_review;
```

## Apply

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0146_drop_transitional_gift_org_columns.sql
```

## Verify after

```sql
-- Backfilled rows are present:
SELECT count(*) FROM donor_payment_intermediaries WHERE id LIKE 'dpibf_%';
-- Columns are gone (expect 0 rows):
SELECT column_name FROM information_schema.columns
WHERE (table_name = 'organizations' AND column_name = 'payment_intermediary_id')
   OR (table_name = 'gifts_and_payments'
       AND column_name IN ('final_amount_source', 'original_human_crm_amount'));
-- Review table is gone (expect 0 rows):
SELECT table_name FROM information_schema.tables
WHERE table_name = 'gift_amount_allocation_review';
-- Enum type is gone (expect 0 rows):
SELECT typname FROM pg_type WHERE typname = 'gift_final_amount_source';
```

Verify by row counts/state, not by clean exit.

## Rollback

Column drops are destructive; the transaction (`-1`) rolls back atomically on
any error. After a successful apply there is no in-place rollback — the
backfilled `dpibf_%` rows preserve the org→intermediary facts, and restoring
the columns would require a schema re-add + reverse backfill from those rows.

## Apply to dev too

The same file applies to dev (same guards, same idempotency):

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0146_drop_transitional_gift_org_columns.sql
```

If a later drizzle push prompts to drop these objects interactively, do NOT
approve the push-driven drop (post-merge-push-abort rule) — this reviewed file
is the drop path for both dev and prod.

## After prod apply

Nothing further — the schema code (columns, `giftAmountAllocationReview`
table, `giftFinalAmountSourceEnum`) and the dead `giftFinalAmount.ts` helper
were all removed in the same change that shipped this amended migration. Just
verify (read-only) per "Verify after" above.
