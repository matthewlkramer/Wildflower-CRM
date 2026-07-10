# Runbook — 0109 + 0110: `issues_to_address` → Cleanup Queue, then drop the columns

## What this does

Retires the per-row free-text `issues_to_address` note (a "something is off here"
note from the 0106 finance-review import) in favour of the polymorphic
`cleanup_queue`, then drops the now-dead columns.

| File | Action |
| --- | --- |
| `0109_move_issues_to_address_to_cleanup_queue.sql` | Copies every non-empty `issues_to_address` note into a `cleanup_queue` row. |
| `0110_drop_issues_to_address_columns.sql` | Drops `issues_to_address` from `staged_payments`, `stripe_payouts`, `gifts_and_payments`. |

The column exists on exactly three tables — `staged_payments`, `stripe_payouts`,
`gifts_and_payments`. It is a plain scalar `text` column with no index, FK, enum,
CHECK, or default depending on it, so nothing else is auto-dropped.

## How the notes map into the queue

| Source | `cleanup_queue.target_type` | `cleanup_queue.id` |
| --- | --- | --- |
| `staged_payments` | `staged_payment` | `cleanup_ita_sp_<id>` |
| `stripe_payouts` | `stripe_payout` | `cleanup_ita_po_<id>` |
| `gifts_and_payments` | `gift` | `cleanup_ita_g_<id>` |

- **`reason_code = 'issues_to_address'`** — a DISTINCT category, deliberately NOT
  `needs_research`. This means:
  - a note **never overwrites** an existing `needs_research` flag on the same
    record (the `(target_type, target_id, reason_code)` unique key keeps them as
    separate rows), and
  - the migrated notes stay a recognisable bucket while still showing in the
    default open-queue view (the list filters by status, not reason_code).
  - They do **not** light up the detail-page "Needs research" badge (that badge is
    `needs_research`-only). `issues_to_address` was never surfaced on detail pages
    before, so this is not a regression.
- `staged_payment` and `stripe_payout` items resolve a display name in the queue
  (QB payer name / tied-deposit payer). `gift` items fall back to `gift <id>` —
  the note text is what matters, and the 0106 import did not populate gift notes,
  so this is expected to be empty/rare.

## Why it is safe (verified read-only against the schema-removal build)

- **No readers, no writers, not in the contract.** `issues_to_address` /
  `issuesToAddress` has ZERO references anywhere outside the three schema files
  and the historical 0106 import — no route, service, OpenAPI spec, Zod schema,
  generated client, frontend, or test names it. Removing it from the Drizzle
  schema is the only code change needed.
- The full `pnpm run typecheck` (which compiles `src/__tests__` too) is green with
  the columns removed from the schema — the authoritative "no residual reference"
  gate.

## Deploy ordering (prod) — **Publish FIRST, then the SQL** (same as 0104/0105/0107/0108)

Publish compares the **dev-DB against the prod-DB** (not the schema source).

1. **Publish this task's code first.** The new build removes `issues_to_address`
   from the schema. At this point **both DBs still hold the columns**, so the diff
   is clean — Publish proposes no drop and deploys successfully.
2. **After the new code is live in prod**, apply the data-move to **prod**, then
   the drop to **prod**:
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0109_move_issues_to_address_to_cleanup_queue.sql
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0110_drop_issues_to_address_columns.sql
   ```
3. Apply the SAME two files, in the SAME order, to **dev**:
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0109_move_issues_to_address_to_cleanup_queue.sql
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0110_drop_issues_to_address_columns.sql
   ```

`psql -1` wraps each file in ONE transaction — do not add `BEGIN`/`COMMIT` inside.

Run the prod and dev applies **back-to-back and do NOT Publish between them.** In
the window where prod has dropped the columns but dev still holds them, a Publish
would see **dev-only columns** and propose an ADDITIVE re-create of the dead
columns.

### ⚠️ Do NOT drop dev alone before Publish

If dev drops the columns while prod still has them, the next Publish sees
**prod-only columns** and proposes a **destructive prod DROP**, which aborts the
whole diff (additive changes skipped → 500 healthcheck → rollback). Keep dev and
prod in lockstep **through** Publish; only after Publish drop **both**.

### Order matters: 0109 before 0110

Apply the data-move (0109) before the drop (0110) so the notes are copied while
the source columns still exist. Both files are guarded, so an out-of-order or
repeat run is safe (0109 becomes a no-op once the columns are gone; 0110 is
`DROP COLUMN IF EXISTS`), but the intended order preserves the notes.

### Note on the post-merge push

When this task merges, `post-merge.sh` runs interactive `drizzle-kit push` against
the **dev** DB. Because the schema dropped the columns but the dev DB still holds
them, push detects a data-loss DROP and **aborts** — expected and harmless for
this merge (it introduces **no additive** schema changes). Once you have run the
dev step above, dev matches the schema again and post-merge push returns to a
clean no-op. Do this promptly so a later merge's additive changes aren't blocked.

## Idempotency

- **0109** — `ON CONFLICT (target_type, target_id, reason_code) DO NOTHING` plus a
  per-table column-exists guard: safe to re-run, never clobbers a note, and is a
  clean no-op even after 0110 has dropped the columns.
- **0110** — `DROP COLUMN IF EXISTS`: a second run is a no-op.

## Verify (read-only)

Before the drop, confirm the notes landed (row counts should match the number of
non-empty source notes on each table):

```sql
-- Migrated notes now in the queue:
SELECT target_type, count(*)
FROM cleanup_queue
WHERE reason_code = 'issues_to_address'
GROUP BY target_type ORDER BY target_type;
```

After the drop (expect ZERO rows):

```sql
SELECT table_name, column_name FROM information_schema.columns
WHERE column_name = 'issues_to_address'
  AND table_name IN ('staged_payments', 'stripe_payouts', 'gifts_and_payments');
```

## Rollback

Structure-only if ever needed: re-add each column from the pre-drop DDL
(`issues_to_address text`). The notes themselves survive as `cleanup_queue` rows
(`reason_code = 'issues_to_address'`), so nothing is lost by not restoring the
columns.
