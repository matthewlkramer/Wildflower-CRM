# Runbook — Phase D step 2: drop `payment_applications` source anchors (0182 + 0183)

## What this does

Retires the three legacy source-anchor columns on `payment_applications` and
everything that depended on them, leaving `payment_unit_id` as the sole ledger
anchor.

| Dropped | Superseded by |
| --- | --- |
| `payment_applications.payment_id` | `payment_units.source_staged_payment_id` (reached via `payment_unit_id`) |
| `payment_applications.stripe_charge_id` | `payment_units.stripe_charge_id` |
| `payment_applications.donorbox_donation_id` | `payment_units.donorbox_donation_id` |
| 3 anchor FK constraints | dropped with the columns |
| `payment_applications_{quickbooks,stripe,donorbox}_evidence_chk` | the anchor is now `payment_unit_id` (NOT NULL) |
| `payment_applications_{payment_id,stripe_charge_id,donorbox_donation_id}_gift_id_uq` (counted) | `payment_applications_payment_unit_id_counted_uq` (0180) |
| `payment_applications_{payment_id,stripe_charge_id}_gift_id_corroborating_uq` | `payment_applications_payment_unit_id_gift_id_corroborating_uq` (0182) |
| 3 anchor lookup indexes | `payment_applications_payment_unit_id_idx` |

The counted per-anchor uniques were already dropped by `0181` (Phase D step 1).
`payment_unit_id` also becomes `NOT NULL` (every row already has a unit —
0178/0179 backfill + eager creation at booking).

## Why it is safe

- **No readers or writers of the columns remain.** Reads/locators/display flipped
  onto `payment_units` in PRs #36–#39; #40 moved counted uniqueness onto the unit;
  this task's PR stops WRITING the anchors in the two remaining insert paths
  (`applyPaymentApplication`, `financialCorrections`) and switches the corrections
  upsert's `ON CONFLICT` to
  `payment_applications_payment_unit_id_gift_id_corroborating_uq`. A green
  `pnpm run typecheck` with the columns removed from the Drizzle schema is the
  authoritative "no residual reference" gate.
- **Uniqueness is preserved.**
  `payment_applications_payment_unit_id_gift_id_corroborating_uq` (0182,
  corroborating-only partial) subsumes the two retiring per-anchor corroborating
  `(anchor, gift)` uniques, and `payment_applications_payment_unit_id_counted_uq`
  (0180, one counted row per unit) subsumes the counted per-anchor uniques. The
  two are disjoint on `link_role`, so a counted and a corroborating row for the
  same `(unit, gift)` still coexist exactly as the retired per-anchor uniques
  allowed. Verified 0 duplicate `(payment_unit_id, gift_id)` pairs on the prod
  clone.

## Deploy ordering (prod) — additive migration → Publish → destructive migration

Publish compares the **dev-DB against the prod-DB** (not the schema source), so
the columns must still exist on BOTH DBs at Publish time.

1. **Apply the additive index to prod, then dev** (safe with the current release
   still dual-writing anchors — the corrections flow's new conflict target needs
   it before the new code serves):
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0182_payment_applications_unit_gift_unique.sql
   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0182_payment_applications_unit_gift_unique.sql
   ```
2. **Publish this task's code.** The build removes the anchor columns from the
   Drizzle schema, but both DBs still hold them, so the Publish diff proposes no
   drop and deploys cleanly. After this, no deployed code reads or writes the
   columns.
3. **After the new code is live in prod**, apply the destructive file to **prod**,
   then **dev**, back-to-back — do NOT Publish between them:
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0183_drop_payment_application_source_anchors.sql
   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0183_drop_payment_application_source_anchors.sql
   ```

`psql -1` wraps each file in ONE transaction — do not add `BEGIN`/`COMMIT` inside.

### ⚠️ Keep dev and prod in lockstep through Publish
Do NOT drop the columns on one DB before the other, and do NOT Publish while the
two DBs disagree on these columns:
- dev-only leftover column → next Publish proposes an additive re-create of a dead
  column.
- prod-only leftover column → next Publish proposes a destructive prod DROP, which
  aborts the whole diff.

### Note on the post-merge push
When this task merges, `post-merge.sh` runs interactive `drizzle-kit push` against
the **dev** DB. Because the schema dropped the columns but dev still holds them,
push detects a data-loss DROP and **aborts** — expected and harmless (no additive
changes are lost). Run step 3's dev command promptly so dev matches the schema
again.

## Idempotency
Every statement uses `IF EXISTS` / `SET NOT NULL` (a no-op when already set), so
both files are safe to re-run.

## Verify (read-only, after applying 0183)
```sql
-- Columns gone (expect ZERO rows):
SELECT column_name FROM information_schema.columns
WHERE table_name = 'payment_applications'
  AND column_name IN ('payment_id','stripe_charge_id','donorbox_donation_id');

-- Anchor now mandatory (expect 'NO'):
SELECT is_nullable FROM information_schema.columns
WHERE table_name = 'payment_applications' AND column_name = 'payment_unit_id';

-- Uniqueness intact (expect both indexes present):
SELECT indexname FROM pg_indexes
WHERE tablename = 'payment_applications'
  AND indexname IN ('payment_applications_payment_unit_id_counted_uq',
                    'payment_applications_payment_unit_id_gift_id_corroborating_uq');
```
