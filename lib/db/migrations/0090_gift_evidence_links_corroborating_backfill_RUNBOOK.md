# Runbook — 0090 Fold `gift_evidence_links` into the ledger as `corroborating`

## What this does

Phase 5 (`docs/reconciliation-design.md` §7 step 5, §5 Decision 2). `gift_evidence_links`
(gel) is the FK-less M:N "corroborating, never counted" evidence table. Decision 2
folds it into the unified `payment_applications` (PA) ledger so there is **one**
ledger, distinguishing counted vs corroborating by `link_role` instead of by a
separate table. This file **backfills** the corroborating PA rows for every gel
row that predates the live dual-write. Going forward the app dual-writes them on
every corroboration (`financialCorrections` `/apply`) and re-homes/deletes them
on gift **combine**. **No legacy column or table is changed or dropped** — purely
additive into the ledger.

## Money-total-neutral

Corroborating rows carry `link_role='corroborating'` and are **excluded from
every counted SUM / tie / settled derivation** (those filter
`link_role='counted'`). This backfill therefore **cannot move a single dollar**;
it only mirrors the existing corroboration annotations into the ledger.

## What is booked (mirrors the live dual-write)

Every gel row becomes **one** corroborating PA row, keyed by anchor:

| gel `evidence_kind` | PA `evidence_source` | anchor column set |
| --- | --- | --- |
| `qb_staged` | `quickbooks` | `payment_id = gel.evidence_id` |
| `stripe_charge` | `stripe` | `stripe_charge_id = gel.evidence_id` |

Provenance mapping:

- `id` = **`gel.id` (REUSED)** — mutual idempotency with the live dual-write,
  which also seeds `PA.id` from `gel.id`, so a gel row and its ledger twin always
  share one id.
- `amount_applied` = `gel.sub_amount`. gel is written ONLY by the corrections
  `/apply` flow, which **never** sets `sub_amount`, so this is `NULL` for every
  existing row — identical to the dual-write's hard-coded `NULL`. The role-aware
  CHECK permits `NULL` (or `> 0`) for corroborating rows; a stray `0`/negative
  would (correctly) fail rather than book a bad amount.
- `match_method` = `'human'`, `link_role` = `'corroborating'` (**never**
  `'counted'` — the whole point), `lifecycle` = `'confirmed'`,
  `created_the_gift` = `false`.
- `confirmed_by_user_id` = `gel.created_by_user_id`; `confirmed_at` =
  `gel.created_at` (best "when confirmed" proxy for a historical row);
  `created_at`/`updated_at` = `gel.created_at`/`gel.updated_at` (preserve
  provenance).

### Corroborating vs counted are DISJOINT (not a conflict)

The two corroborating partial uniques
(`payment_applications_{payment_id,stripe_charge_id}_gift_id_corroborating_uq`)
are separate from the counted book-once uniques (both partial on `link_role`), so
a **counted** row and a **corroborating** row for the same `(anchor, gift)`
coexist without collision. That is intended — a corroborating row is a faithful
mirror of a gel annotation, not a second booking of the money.

## Ordering

Requires migration **0065** (the `payment_applications` table + enums) **and the
S1 schema change** that added the corroborating partial uniques + the role-aware
`amount_applied` CHECK. This file only reads gel + writes PA, so those
columns/indexes must already exist in prod.

### Deploy ordering (prod)

The dual-write code (Phase-5 `/apply` + gift-combine re-home) must be live
before — or at the same time as — this backfill, so no corroboration is missed
between backfill and code going live. Order on prod:

1. **Publish/deploy** the S1 schema + S2 dual-write code.
2. Apply **0090**.

Because every INSERT is `ON CONFLICT (…) DO NOTHING`, running 0090 after
dual-write has begun never duplicates a row the live code wrote.

## Prod schema pre-check (run BEFORE applying)

This backfill depends on the **S1 schema change** having reached prod via Publish:
the role-aware `amount_applied` CHECK, the `amount_applied` NULLability, and — the
easy-to-miss part — the **re-scoping of the three existing book-once uniques to
`WHERE link_role='counted'`** plus the two NEW corroborating partial uniques. This
table has a history of distrusted Publish diffs, so verify the live prod schema
read-only first. If the corroborating uniques are missing, the INSERTs fail with
_"no unique or exclusion constraint matching the ON CONFLICT specification"_; if
the counted uniques were NOT re-scoped, a corroborating link that overlaps a
counted `(anchor, gift)` would 23505 instead of landing in its own row.

```sql
-- 1. amount_applied must be NULLable (S1 relaxed it for corroborating rows):
SELECT is_nullable FROM information_schema.columns
WHERE table_name = 'payment_applications' AND column_name = 'amount_applied';
--   expect: YES

-- 2. The role-aware amount CHECK must be present:
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conname = 'payment_applications_amount_applied_positive';
--   expect: (link_role = 'counted' AND amount_applied > 0)
--        OR (link_role = 'corroborating' AND (amount_applied IS NULL OR amount_applied > 0))

-- 3. All 5 partial uniques must exist with the right predicates — the 3 counted
--    book-once uniques re-scoped to link_role='counted', and the 2 corroborating
--    uniques this backfill's ON CONFLICT targets:
SELECT indexname, pg_get_indexdef(indexrelid) AS def
FROM pg_indexes JOIN pg_class ON pg_class.relname = indexname
WHERE tablename = 'payment_applications' AND indexname LIKE '%uq'
ORDER BY indexname;
--   expect these 5 (each WHERE-clause matters):
--     payment_applications_payment_id_gift_id_uq                    ... WHERE (link_role = 'counted')
--     payment_applications_stripe_charge_id_gift_id_uq             ... WHERE ((stripe_charge_id IS NOT NULL) AND (link_role = 'counted'))
--     payment_applications_donorbox_donation_id_gift_id_uq         ... WHERE ((donorbox_donation_id IS NOT NULL) AND (link_role = 'counted'))
--     payment_applications_payment_id_gift_id_corroborating_uq     ... WHERE ((payment_id IS NOT NULL) AND (link_role = 'corroborating'))
--     payment_applications_stripe_charge_id_gift_id_corroborating_uq ... WHERE ((stripe_charge_id IS NOT NULL) AND (link_role = 'corroborating'))
```

Only proceed once all three checks pass on prod. If any is missing, the S1 schema
did not fully deploy — re-Publish (or hand-apply the missing DDL) before this file.

## Apply

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0090_gift_evidence_links_corroborating_backfill.sql
```

For production, use `$PROD_DATABASE_URL`:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0090_gift_evidence_links_corroborating_backfill.sql
```

`psql -1` wraps the whole file in ONE transaction — do not add `BEGIN`/`COMMIT`
inside the file (it would nest and warn).

## Idempotency

Safe to re-run. Each INSERT is `ON CONFLICT (<anchor>, gift_id) WHERE <anchor> IS
NOT NULL AND link_role='corroborating' DO NOTHING` (the partial-index predicate
is repeated so Postgres infers the per-anchor **corroborating** partial unique),
so a second run — or a run after live dual-write has begun (same id, same
anchor) — is a no-op for any pair that already exists; it only fills genuinely
missing rows. The JOIN to `gifts_and_payments` skips an orphaned/stale gel row
rather than aborting the load on the `gift_id` FK (ON DELETE RESTRICT).

## Verify — then run the PROD parity gate

```sql
-- Corroborating ledger row count by source vs the gel counts (should match):
SELECT evidence_source, count(*) FROM payment_applications
WHERE link_role = 'corroborating' GROUP BY 1 ORDER BY 1;
SELECT evidence_kind, count(*) FROM gift_evidence_links GROUP BY 1 ORDER BY 1;
```

Then run the authoritative bidirectional gate against prod (both orphan sets must
be zero — this is the gate that unblocks the S5 read-flip):

```bash
DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/api-server run parity:gift-evidence-links --out /tmp/gel-parity-prod.json
```

The SQL verification block at the foot of the `.sql` file contains the same two
bidirectional parity queries if you prefer to run them by hand.

## Rollback

Corroborating rows are unread until the S5 read-flip ships (readers filter
`link_role='counted'`), so they can be cleared without affecting any live read.
Blunt clear (only safe **before** the S5 read-flip / while gel is still the read
source — otherwise skip):

```sql
DELETE FROM payment_applications WHERE link_role = 'corroborating';
```
