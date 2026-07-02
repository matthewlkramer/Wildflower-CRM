# Runbook — 0087 payment_applications link_role / lifecycle / nullable payment_id prep

## What this does

Brings the prod `payment_applications` table from its original QuickBooks-only
shape (migration 0065) up to the current polymorphic-ledger shape, so the
Stripe/Donorbox dual-write code and the 0086 backfill can go live. Purely
additive; drops nothing.

Deltas applied (all idempotent):

1. `payment_application_link_role` enum (`counted` | `corroborating`) + `link_role`
   column `NOT NULL DEFAULT 'counted'`. **Every ledger reader now filters
   `link_role='counted'`, so this column MUST exist before the code goes live.**
2. `payment_application_lifecycle` enum (`proposed` | `confirmed`) + `lifecycle`
   column `NOT NULL DEFAULT 'confirmed'`.
3. `payment_id` → `DROP NOT NULL` (only quickbooks rows carry it; stripe/donorbox
   rows anchor on `stripe_charge_id` / `donorbox_donation_id`).
4. `payment_applications_quickbooks_evidence_chk` CHECK (`evidence_source <>
   'quickbooks' OR payment_id IS NOT NULL`) — preserves the quickbooks anchor
   invariant now that `payment_id` is nullable.
5. Partial UNIQUE book-once indexes on `(stripe_charge_id, gift_id)` and
   `(donorbox_donation_id, gift_id)`. **Required by 0086's `ON CONFLICT`** — 0065
   only created plain (non-unique) indexes on those columns, so without this file
   0086 errors: "no unique or exclusion constraint matching the ON CONFLICT
   specification".

## Why hand-applied (not the Publish diff)

Same reason as 0065/0083: the Publish schema diff diffs the whole dev DB and can
abort on unrelated drift or skip additive creates. This file applies exactly the
ledger deltas without touching anything else.

## Order on prod

1. **Apply this file (0087)** — schema prep.
2. **Publish** the Stripe/Donorbox dual-write + reader code. (The Publish diff
   finds these objects already present → no-op for `payment_applications`.)
3. **Apply 0086** — the Stripe/Donorbox backfill.

Rationale: the code that reads `link_role` needs the column first; 0086 needs the
partial unique indexes + nullable `payment_id`; and having the dual-write live
before the backfill means no settle is missed in between (0086's `ON CONFLICT DO
NOTHING` dedupes any overlap).

## Apply

```bash
# dev
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0087_payment_applications_link_role_lifecycle_prep.sql
# prod (human-applied)
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0087_payment_applications_link_role_lifecycle_prep.sql
```

## Verify (after applying)

```sql
-- columns present + payment_id nullable
SELECT column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'payment_applications'
  AND column_name IN ('payment_id','link_role','lifecycle')
ORDER BY column_name;

-- both partial unique book-once indexes exist
SELECT indexname FROM pg_indexes
WHERE tablename = 'payment_applications'
  AND indexname LIKE '%\_gift\_id\_uq' ESCAPE '\'
ORDER BY indexname;

-- all four evidence/amount checks exist
SELECT conname FROM pg_constraint
WHERE conrelid = 'payment_applications'::regclass AND contype = 'c'
ORDER BY conname;
```

Idempotent: re-running is a pure no-op (guarded enums, `ADD COLUMN IF NOT EXISTS`,
`DROP NOT NULL` on already-nullable, `CREATE UNIQUE INDEX IF NOT EXISTS`,
pg_constraint-guarded CHECK).
