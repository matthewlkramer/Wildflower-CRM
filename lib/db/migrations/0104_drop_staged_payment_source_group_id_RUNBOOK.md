# Runbook — 0104 Drop `staged_payments.source_group_id`

## What this does

Physically drops the **now-dead legacy grouping column** (and its index) from
`staged_payments`. "Same physical gift" grouping lives in the polymorphic
`unit_groups` / `unit_group_members` tables (membership = `unit_group_members`
rows with `evidence_source = 'quickbooks'` and `source_id = staged_payments.id`).
Every read (workbench card collapse / representative pick / group rollup,
settlement bundle anchor eligibility, reconciliation graph, approve) **and** every
write (`POST /staged-payments/group` and `/ungroup`) was flipped onto
`unit_group_members` in this task, so the column is fully dead. 0104 removes it:

| Dropped | Was |
| --- | --- |
| `source_group_id` | shared opaque id tying separately-entered QuickBooks records into one "same physical gift" group (`text`, nullable) |
| `staged_payments_source_group_id_idx` | index on `source_group_id` |

**Not dropped:** `group_reconciled_gift_id` — a different concern (members tied to
one *existing* gift), intentionally retained.

## Why it is safe

- **`unit_group_members` is the sole authoritative home** for grouping. Parity
  between the legacy column and `unit_group_members` was proven on **prod**
  (`parity-unit-groups` / `parity-group-readflip`) during the dual-write phase
  before the read+write flip, so the column is unread; after this task's code
  deploys it is also unwritten.
- **Money-total-neutral.** `source_group_id` was a pure staged-payments
  review-state pointer — it never fed a gift, a paid-amount derivation, or a goal
  SUM (that flows through `gifts_and_payments` / `gift_allocations` /
  `payment_applications`, untouched here). Dropping it cannot move a counted
  dollar.
- Dropping the column auto-removes the dependent index (the explicit
  `DROP INDEX IF EXISTS` is belt-and-suspenders).

## Deploy ordering (prod) — **Publish FIRST, then this SQL**

`source_group_id` is still **written** by the currently-deployed prod build (the
dual-write). Dropping it before the new code deploys would 500 every group/ungroup
call. So:

1. **Publish this task's code first.** The new build stops writing (and reading)
   `source_group_id`. Publish diffs **dev-DB vs prod-DB** (not the schema source),
   and at this point **both DBs still hold the column**, so the diff is clean —
   Publish proposes no drop and deploys successfully. Drizzle selects by schema
   definition, so the new code ignores the still-present physical column (nullable
   → INSERTs that omit it succeed).
2. **After the new code is live in prod**, apply this file to **prod** (drops the
   now-fully-dead column — safe, nothing writes it):
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0104_drop_staged_payment_source_group_id.sql
   ```
3. Apply the SAME file to **dev** (the dev app is on the merged code, which also no
   longer writes the column):
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0104_drop_staged_payment_source_group_id.sql
   ```

`psql -1` wraps the file in ONE transaction — do not add `BEGIN`/`COMMIT` inside it.

Run steps 2 and 3 **back-to-back and do NOT Publish between them.** In the window
where prod has dropped the column but dev still holds it, a Publish would see a
**dev-only column** and propose an ADDITIVE re-create of the dead column on prod —
which succeeds silently and undoes step 2.

### ⚠️ Do NOT drop dev alone before Publish

If dev drops the column while prod still has it, the next Publish sees a
**prod-only column** and proposes a **destructive prod DROP**, which aborts the
whole diff (additive changes skipped → 500 healthcheck → rollback). Keep dev and
prod in lockstep **through** Publish; only after Publish drop **both**.

### Note on the post-merge push

When this task merges, `post-merge.sh` runs interactive `drizzle-kit push` against
the **dev** DB. Because the schema dropped this column but the dev DB still holds
it, push detects a data-loss DROP and **aborts** — this is expected and harmless
for this merge (it introduces **no additive** schema changes, so nothing is lost;
the dev app keeps serving with the column as a dead orphan). Once you have run step
3 above, dev matches the schema again and post-merge push returns to a clean no-op.
Do this promptly so a later merge's additive changes aren't blocked by the same
data-loss abort.

## Idempotency

`DROP INDEX IF EXISTS` + `DROP COLUMN IF EXISTS` → safe to re-run; a second run is a
no-op.

## Verify (read-only, after applying)

```sql
-- Column gone (expect ZERO rows):
SELECT column_name FROM information_schema.columns
WHERE table_name = 'staged_payments' AND column_name = 'source_group_id';

-- Index gone (expect NULL):
SELECT to_regclass('public.staged_payments_source_group_id_idx');

-- unit_group_members (the authoritative store) untouched; every QB group still
-- has >= 2 members (expect ZERO rows):
SELECT group_id, count(*) FROM unit_group_members
WHERE evidence_source = 'quickbooks'
GROUP BY group_id HAVING count(*) < 2;

-- group_reconciled_gift_id (the separate concern) untouched (expect one row):
SELECT column_name FROM information_schema.columns
WHERE table_name = 'staged_payments' AND column_name = 'group_reconciled_gift_id';
```

## Rollback

Structure-only if ever needed: re-add the column/index from the pre-drop DDL. There
is nothing to restore into it — grouping is fully superseded by
`unit_group_members`. Treat rollback as schema shape, not data recovery.
