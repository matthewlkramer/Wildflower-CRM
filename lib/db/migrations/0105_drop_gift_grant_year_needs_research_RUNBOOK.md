# Runbook — 0105 Drop the retired gift-header `grant_year` and `needs_research`

## What this does

Physically drops two retired header columns on `gifts_and_payments` (Task #598):

| Dropped | Superseded by |
| --- | --- |
| `gifts_and_payments.grant_year` | `gift_allocations.grant_year` — grant year is allocation-level now (gift create seeds it on the allocation; the split-gift path copies each allocation's own grant year) |
| `gifts_and_payments.needs_research` | the Cleanup Queue — the derived, read-only `flaggedForResearch` badge from an OPEN `cleanup_queue` row (`reason_code='needs_research'`) |

The `grant_year` FK to `fiscal_years` and its index (`gifts_and_payments_grant_year_idx`)
are **auto-dropped with the column** — no separate statements needed.

## Why it is safe (verified read-only against the schema-removal build)

- **`grant_year`** is no longer read or written by application code:
  - Gift create pulls `grantYear` out of the body and threads it to the seeded
    **allocation** (it stays on the CREATE body only, where it seeds that allocation).
  - The split-gift path copies each **allocation's own** grant year; no header copy
    is written.
  - The gift detail UI reads only the derived `grantYears[]` array.
  - The OpenAPI spec drops `grantYear` from the Gift **response** and the **update**
    body (kept on CREATE, where it seeds the allocation).
- **`needs_research`** was already stripped from EVERY response projection
  (`giftHeaderColumns`) and removed from the create/update API bodies in a prior
  task — no deployed build selects or writes it. No index/FK/enum depends on it.

## Deploy ordering (prod) — **Publish FIRST, then this SQL** (same as 0104)

The gate is **`grant_year`**: it is no longer written, but the currently-deployed
prod build still **SELECTs** it (`select()` / `getTableColumns` emit every schema
column; the response is scrubbed only AFTER the read). (`needs_research` is already
unselected, so it is safe either way — it is bundled here purely to consolidate the
DROP.) So:

1. **Publish this task's code first.** The new build removes both columns from the
   schema and stops selecting `grant_year`. Publish diffs **dev-DB vs prod-DB** (not
   the schema source), and at this point **both DBs still hold both columns**, so the
   diff is clean — Publish proposes no drop and deploys successfully.
2. **After the new code is live in prod**, apply this file to **prod**:
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0105_drop_gift_grant_year_needs_research.sql
   ```
3. Apply the SAME file to **dev**:
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0105_drop_gift_grant_year_needs_research.sql
   ```

`psql -1` wraps the file in ONE transaction — do not add `BEGIN`/`COMMIT` inside it.

Run steps 2 and 3 **back-to-back and do NOT Publish between them.** In the window
where prod has dropped the columns but dev still holds them, a Publish would see
**dev-only columns** and propose an ADDITIVE re-create of the dead columns on prod.

### ⚠️ Do NOT drop dev alone before Publish

If dev drops the columns while prod still has them, the next Publish sees a
**prod-only column** and proposes a **destructive prod DROP**, which aborts the
whole diff (additive changes skipped → 500 healthcheck → rollback). Keep dev and
prod in lockstep **through** Publish; only after Publish drop **both**.

### Note on the post-merge push

When this task merges, `post-merge.sh` runs interactive `drizzle-kit push` against
the **dev** DB. Because the schema dropped these columns but the dev DB still holds
them, push detects a data-loss DROP and **aborts** — expected and harmless for this
merge (it introduces **no additive** schema changes, so nothing is lost; the dev
app keeps serving with the columns as dead orphans). Once you have run step 3, dev
matches the schema again and post-merge push returns to a clean no-op. Do this
promptly so a later merge's additive changes aren't blocked by the same abort.

## Idempotency

`DROP COLUMN IF EXISTS` → safe to re-run; a second run is a no-op.

## Verify (read-only, after applying)

```sql
-- Both columns gone (expect ZERO rows):
SELECT column_name FROM information_schema.columns
WHERE table_name = 'gifts_and_payments'
  AND column_name IN ('grant_year','needs_research');

-- The dropped index is gone too (expect ZERO rows):
SELECT indexname FROM pg_indexes
WHERE tablename = 'gifts_and_payments'
  AND indexname = 'gifts_and_payments_grant_year_idx';

-- Grant year still lives on the allocations (expect a healthy non-zero count):
SELECT count(*) FROM gift_allocations WHERE grant_year IS NOT NULL;
```

## Rollback

Structure-only if ever needed: re-add the columns from the pre-drop DDL
(`grant_year text` with a `REFERENCES fiscal_years(id) ON DELETE RESTRICT` FK and a
`gifts_and_payments_grant_year_idx` index; `needs_research boolean NOT NULL DEFAULT
false`). There is nothing to restore into them — grant year lives on
`gift_allocations.grant_year` and "needs research" lives in the Cleanup Queue.
