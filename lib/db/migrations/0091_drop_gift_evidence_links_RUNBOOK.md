# Runbook — 0091 Drop the deprecated `gift_evidence_links` table

## What this does

Phase 5 (`docs/reconciliation-design.md` §7 step 7 — "deprecate, then, much later,
human-gated, drop legacy"). Physically `DROP TABLE gift_evidence_links` (gel), the
FK-less M:N "corroborating, never counted" evidence table that Decision 2 folded
into the unified `payment_applications` (PA) ledger as `link_role='corroborating'`
rows.

This is the final step of the gel lifecycle:

| Step | What shipped |
| --- | --- |
| S1–S4 | additive schema + dual-write + dev/prod parity + backfill (0090) |
| S5 | read-flip — every gel reader switched onto the corroborating ledger; nothing reads or writes gel |
| S6 | gel marked `@deprecated` |
| **S7 (this file)** | the physical drop |

## Why it is safe

- **The corroborating ledger is gel's sole home.** Since S5, the corrections
  `/apply` flow writes only a corroborating PA row and gift-combine re-homes only
  PA rows. No live code reads or writes gel.
- **gel is empty in prod** (0 rows at the S4 parity gate) and dead. Even if a row
  existed, 0090 + the live dual-write already mirrored every gel row into a
  corroborating PA twin, so dropping the table loses no evidence link.
- **Money-total-neutral.** Corroborating rows are excluded from every counted
  SUM / tie / settled derivation; gel never entered one either. This cannot move a
  dollar.

## Pre-check (run BEFORE applying, read-only)

```sql
-- 1. gel is empty (or every row already has a corroborating PA twin). Expect 0:
SELECT count(*) AS gel_rows FROM gift_evidence_links;

-- 2. Belt-and-suspenders: any gel row WITHOUT a corroborating ledger twin.
--    Expect ZERO rows (trivially true when gel_rows = 0):
SELECT gel.id
FROM gift_evidence_links gel
WHERE NOT EXISTS (
  SELECT 1 FROM payment_applications pa
  WHERE pa.link_role = 'corroborating' AND pa.gift_id = gel.gift_id
    AND ((gel.evidence_kind = 'qb_staged'
            AND pa.evidence_source = 'quickbooks'
            AND pa.payment_id = gel.evidence_id)
      OR (gel.evidence_kind = 'stripe_charge'
            AND pa.evidence_source = 'stripe'
            AND pa.stripe_charge_id = gel.evidence_id)));
```

If check 2 returns any rows, STOP — run/re-run `0090` (the backfill) first so no
link is lost, then re-check. Only proceed once check 2 is empty.

## Deploy ordering (prod) — SQL first, THEN Publish

1. Confirm **S5 + S6 are live** (they are — nothing reads gel).
2. Apply **0091** to prod (the command below).
3. **Then Publish** the S7 code (removes gel from the Drizzle schema, deletes the
   obsolete `parity-gift-evidence-links` script + its `package.json` entry, drops
   the test's gel references).

Dropping via this reviewed SQL **first** means the subsequent Publish diffs
prod-has-no-table against schema-has-no-table → **no destructive schema diff**, so
drizzle-kit never proposes (or interactively stalls on) the DROP. If you Publish
first instead, the Publish diff would see the table only in prod and propose to
drop it — avoid that path (this repo has a history of distrusted / interactively
aborting Publish diffs on drops).

## Apply

```bash
# dev
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0091_drop_gift_evidence_links.sql
```

```bash
# production
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0091_drop_gift_evidence_links.sql
```

`psql -1` wraps the file in ONE transaction — do not add `BEGIN`/`COMMIT` inside it.

## Idempotency

`DROP TABLE IF EXISTS` → safe to re-run; a second run is a no-op.

## Verify

```sql
SELECT to_regclass('public.gift_evidence_links');   -- expect: NULL (gone)
SELECT link_role, count(*) FROM payment_applications GROUP BY 1 ORDER BY 1;  -- ledger untouched
```

## Rollback

The table can be recreated from its original DDL in `0063_financial_corrections.sql`
if ever needed, but there is nothing to restore into it: gel was empty / fully
mirrored, and the corroborating PA ledger remains the live source. Treat rollback
as schema-only (structure), not data recovery.
