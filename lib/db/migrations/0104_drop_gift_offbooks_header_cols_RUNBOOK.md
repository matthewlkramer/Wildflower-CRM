# Runbook — 0104 Drop the retired off-books header booleans

## What this does

Physically drops the three retired header booleans on `gifts_and_payments`. Off-books
/ payment-exempt is now an **allocation-level** derivation (`entities.expects_payment
= false`), computed by `giftIsOffBooksExpr()` — the header flags are gone.

| Dropped | Off-books signal now |
| --- | --- |
| `gifts_and_payments.designated_to_school` | allocation on `direct_to_school` (no-payment entity) |
| `gifts_and_payments.off_books_fiscal_sponsor` | allocation on `wildflower_foundation_tsne` (no-payment entity) |
| `gifts_and_payments.payment_expected` | any allocation on a payment-bearing entity ⇒ expects payment |

This is the deferred column DROP that follows the **0103** data backfill.

## Why it is safe (verified read-only, dev AND prod, gated on 0103)

- **0103 must run first.** It repointed every header-off-books gift's allocations
  onto the matching no-payment entity and its final guard PROVES zero off-books →
  on-books flips.
- The columns are no longer READ or WRITTEN by the new build: the derivation, the
  audit-reconciliation route, the gift PATCH change-detection, and the split-gift
  path all use the allocation-only expression; the OpenAPI spec no longer exposes
  the fields; the UI toggles are gone.
- No indexes, FKs, or enum types depend on these plain boolean columns.

## Pre-checks (re-run read-only against prod right before scheduling the drop)

```sql
-- expect ZERO header-off-books gift that is NOT off-books by allocation
-- (i.e. 0103 fully applied; a non-zero result means STOP and re-run 0103):
SELECT count(*) FROM gifts_and_payments g
WHERE (g.designated_to_school OR g.off_books_fiscal_sponsor OR g.payment_expected = false)
  AND NOT (
    EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM gift_allocations ga LEFT JOIN entities e ON e.id = ga.entity_id
      WHERE ga.gift_id = g.id AND (ga.entity_id IS NULL OR COALESCE(e.expects_payment, true) = true)
    )
  );
```

## Deploy ordering (prod) — **Publish FIRST, then this SQL** (same as 0094)

The columns are no longer written, but the currently-deployed prod build still
**SELECTs** them (`select()` / `getTableColumns` emit every schema column; the
response is scrubbed only AFTER the read). So:

1. **Publish this task's code first.** The new build removes the columns from the
   schema and stops selecting them. Publish diffs **dev-DB vs prod-DB** (not the
   schema source), and at this point **both DBs still hold all three columns**, so
   the diff is clean — Publish proposes no drop and deploys successfully.
2. **After the new code is live in prod**, apply this file to **prod**:
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0104_drop_gift_offbooks_header_cols.sql
   ```
3. Apply the SAME file to **dev**:
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0104_drop_gift_offbooks_header_cols.sql
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
-- All three columns gone (expect ZERO rows):
SELECT column_name FROM information_schema.columns
WHERE table_name = 'gifts_and_payments'
  AND column_name IN ('designated_to_school','off_books_fiscal_sponsor','payment_expected');

-- Off-books gifts still derivable from allocations (expect the 49 designated, now
-- on direct_to_school, plus any pre-existing no-payment-entity gifts):
SELECT count(*) FROM gifts_and_payments g
WHERE EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g.id)
  AND NOT EXISTS (
    SELECT 1 FROM gift_allocations ga LEFT JOIN entities e ON e.id = ga.entity_id
    WHERE ga.gift_id = g.id AND (ga.entity_id IS NULL OR COALESCE(e.expects_payment, true) = true)
  );
```

## Rollback

Structure-only if ever needed: re-add the columns from the pre-drop DDL
(`designated_to_school` / `off_books_fiscal_sponsor` `boolean NOT NULL DEFAULT
false`; `payment_expected` `boolean NOT NULL DEFAULT true`). There is nothing to
restore into them — the authoritative off-books signal lives on the allocation
entities.
