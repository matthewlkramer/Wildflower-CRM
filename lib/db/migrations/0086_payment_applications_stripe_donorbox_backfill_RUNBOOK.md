# Runbook — 0086 Stripe + Donorbox cash-application ledger backfill (`payment_applications`)

## What this does

Phase 2 (dual-write + backfill), the **Stripe + Donorbox** half. Migration 0066
seeded the QuickBooks rows (`evidence_source='quickbooks'`); this file seeds the
Stripe (`evidence_source='stripe'`) and Donorbox (`evidence_source='donorbox'`)
rows that predate their live dual-write. The app dual-writes these rows going
forward (`bookStripeChargeApplication` / `bookDonorboxDonationApplication`); this
file only seeds the back-catalog. **No legacy column or table is changed or
dropped** — purely additive into the ledger.

### Stripe (`stripe_staged_charges` → 1 row per settled charge)

- Every charge with a settled gift pointer: `matched_gift_id` (linked to a
  PRE-EXISTING gift — also the QB-anchored reconcile and worker auto-apply case)
  OR `created_gift_id` (a NEW gift minted from the charge).
- A charge settles at most ONE gift and always nulls the other pointer, so
  `gift_id = COALESCE(matched_gift_id, created_gift_id)` and
  `created_the_gift = (created_gift_id IS NOT NULL)`. A revert clears BOTH
  pointers, so a non-null pointer means "currently settled".
- `amount_applied = gross_amount` (donors are credited the GROSS charge).

### Donorbox (`donorbox_donations` → 1 row per human-settled donation)

- Every donation with `matched_gift_id` (human **link** → PRE-EXISTING gift) OR
  `created_gift_id` (human **mint** → NEW gift). Same COALESCE + `created_the_gift`
  logic as Stripe.
- `amount_applied = amount`.
- **Enrich-only donations are correctly excluded.** The Donorbox sync's
  enrichment and suggested-donor paths NEVER set a gift-link column on the
  donation row (they enrich the existing Stripe gift / seed a donor hint), so
  keying on `matched_gift_id`/`created_gift_id` books ONLY the two human review
  routes — exactly what the dual-write books.

## Provenance mapping (mirrors the live dual-write)

- `evidence_source` = `'stripe'` / `'donorbox'` per source.
- **Stripe** `match_method` = `'system'` when `auto_applied` (the sync worker's
  auto-apply), else `'human'` (every reconcile / mint / link path sets
  `auto_applied=false`). Stripe auto-apply is terminal-until-revert with no
  confirm-promotion, so `'system_confirmed'` is intentionally unreachable here.
- **Donorbox** `match_method` is always `'human'` — Donorbox never auto-applies.
- `confirmed_by_user_id` / `confirmed_at` come from each source's
  `match_confirmed_*` (null for the auto-applied Stripe rows, which never stamp
  them).
- `link_role` (`'counted'`) and `lifecycle` (`'confirmed'`) are left to their
  column defaults, exactly as the dual-write helper does.
- `amount_applied` has a CHECK (> 0), so each source filters out null /
  non-positive amounts (mirrors the dual-write `if (amount > 0)` no-op).

## Parallel evidence (NOT a conflict)

A gift settled by BOTH a QB payment and a Stripe charge gets one `'quickbooks'`
row (0066) AND one `'stripe'` row (here) — different anchors, different per-anchor
unique keys, different rows. The per-gift derivations read one `evidence_source`
at a time and never sum across sources, so this backfill must NOT (and does not)
dedupe across sources.

## Ordering

Requires migration **0065** (the `payment_applications` table + enums) and the
source tables (`stripe_staged_charges`, `donorbox_donations`,
`gifts_and_payments`). Independent of 0066 (a different `evidence_source`), but
conventionally applied after it.

### Deploy ordering

Dual-write code must be live before — or at the same time as — this backfill so no
Stripe/Donorbox booking is missed between backfill and code going live. Order on
prod: apply 0065 → Publish/deploy the Stripe+Donorbox dual-write code → apply
0086. Because every INSERT is `ON CONFLICT (…) DO NOTHING`, running 0086 after
dual-write has begun never duplicates a row the live code wrote.

## Apply

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0086_payment_applications_stripe_donorbox_backfill.sql
```

For production, use `$PROD_DATABASE_URL`:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0086_payment_applications_stripe_donorbox_backfill.sql
```

`psql -1` wraps the whole file in ONE transaction — do not add `BEGIN`/`COMMIT`
inside the file (it would nest and warn).

## Idempotency

Safe to re-run. Every INSERT is `ON CONFLICT (<anchor>, gift_id) WHERE <anchor> IS
NOT NULL DO NOTHING` (the partial-index predicate is repeated so Postgres can
infer the per-anchor partial unique index), so a second run — or a run after live
dual-write has begun — is a no-op for any pair that already exists; it only fills
in genuinely missing rows. Each source JOINs to `gifts_and_payments`, so an
orphaned/stale pointer is skipped rather than aborting the load on the `gift_id`
FK (ON DELETE RESTRICT).

## Verify

```sql
-- Row count by source (quickbooks from 0066; stripe/donorbox from here):
SELECT evidence_source, created_the_gift, match_method, count(*)
FROM payment_applications GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- STRIPE parity: every settled charge has its ledger row (should be empty).
SELECT sc.id
FROM stripe_staged_charges sc
JOIN gifts_and_payments g
  ON g.id = COALESCE(sc.matched_gift_id, sc.created_gift_id)
WHERE (sc.matched_gift_id IS NOT NULL OR sc.created_gift_id IS NOT NULL)
  AND sc.gross_amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.stripe_charge_id = sc.id
      AND pa.gift_id = COALESCE(sc.matched_gift_id, sc.created_gift_id)
  );

-- DONORBOX parity: same shape for the two human review routes (should be empty).
SELECT dd.id
FROM donorbox_donations dd
JOIN gifts_and_payments g
  ON g.id = COALESCE(dd.matched_gift_id, dd.created_gift_id)
WHERE (dd.matched_gift_id IS NOT NULL OR dd.created_gift_id IS NOT NULL)
  AND dd.amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.donorbox_donation_id = dd.id
      AND pa.gift_id = COALESCE(dd.matched_gift_id, dd.created_gift_id)
  );
```

## Rollback

The Stripe/Donorbox ledger rows are still unread in Phase 2 (the readers filter
`evidence_source='quickbooks'`), so they can be cleared without affecting any live
read. Blunt clear of the two sources (only safe before dual-write traffic —
otherwise skip, it would also drop live dual-written rows):

```sql
DELETE FROM payment_applications WHERE evidence_source IN ('stripe', 'donorbox');
```
