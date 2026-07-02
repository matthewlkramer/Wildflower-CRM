-- Migration 0087: Bring payment_applications up to the polymorphic-ledger shape
-- so the Stripe/Donorbox dual-write code and the 0086 backfill can go live.
--
-- WHY THIS FILE EXISTS
--   The table was first created by 0065 in its QuickBooks-only shape: payment_id
--   NOT NULL, no link_role / lifecycle, and only PLAIN (non-unique) indexes on
--   stripe_charge_id / donorbox_donation_id. Since then the Drizzle schema grew a
--   polymorphic (quickbooks | stripe | donorbox) anchor model:
--     * payment_id is NULLABLE (only quickbooks rows carry it; stripe/donorbox
--       rows anchor on stripe_charge_id / donorbox_donation_id instead),
--     * link_role  (counted | corroborating, default 'counted')  — every READER
--       now filters link_role='counted', so the column MUST exist before the code
--       that references it goes live or those queries 500,
--     * lifecycle  (proposed | confirmed, default 'confirmed'),
--     * PARTIAL UNIQUE book-once keys on (stripe_charge_id, gift_id) and
--       (donorbox_donation_id, gift_id) — REQUIRED by the 0086 backfill's
--       `ON CONFLICT (<anchor>, gift_id) WHERE <anchor> IS NOT NULL` clauses
--       (without them 0086 errors: "no unique or exclusion constraint matching
--       the ON CONFLICT specification"),
--     * a quickbooks evidence CHECK (evidence_source <> 'quickbooks' OR
--       payment_id IS NOT NULL) — preserves "quickbooks rows carry payment_id"
--       now that the column is nullable.
--   0065 is CREATE TABLE IF NOT EXISTS, so re-running it CANNOT retrofit an
--   existing table. This file applies exactly those deltas, idempotently, without
--   trusting the Publish schema diff (which diffs the whole dev DB and can abort
--   on unrelated drift / skip additive creates — see 0065's header).
--
-- SAFETY / IDEMPOTENCY (re-running is a pure no-op):
--   * enum creates are pg_type-guarded DO blocks.
--   * ADD COLUMN IF NOT EXISTS with a NOT NULL DEFAULT backfills existing rows
--     with the default ('counted' / 'confirmed') — correct: every pre-existing
--     row is a settled, counted booking.
--   * ALTER COLUMN ... DROP NOT NULL is a no-op when already nullable.
--   * CREATE UNIQUE INDEX IF NOT EXISTS — the partial predicate matches zero
--     existing rows (all current rows are quickbooks, so both anchors are NULL),
--     so the indexes build instantly and can never conflict on historical data.
--   * the quickbooks CHECK is added only if absent (pg_constraint-guarded); all
--     existing quickbooks rows already carry payment_id, so it validates clean.
--   * purely additive — drops nothing, rewrites no data.
--
-- ORDERING (prod): apply THIS file -> Publish the Stripe/Donorbox dual-write
--   code -> apply 0086 (the Stripe/Donorbox backfill). The schema must exist
--   before the code that reads link_role goes live, and the partial unique
--   indexes + nullable payment_id must exist before 0086 runs. Publishing after
--   this file means the Publish diff finds these objects already present (no-op
--   for payment_applications).
--
-- Apply with psql -1 (wraps the whole file in ONE transaction; do NOT add a
-- BEGIN/COMMIT here or it nests and warns):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0087_payment_applications_link_role_lifecycle_prep.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0087_payment_applications_link_role_lifecycle_prep.sql   (prod)

-- 1. New enum types ---------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_application_link_role') THEN
    CREATE TYPE payment_application_link_role AS ENUM (
      'counted',
      'corroborating'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_application_lifecycle') THEN
    CREATE TYPE payment_application_lifecycle AS ENUM (
      'proposed',
      'confirmed'
    );
  END IF;
END
$$;

-- 2. New columns (NOT NULL with defaults backfill existing rows) -------------
ALTER TABLE payment_applications
  ADD COLUMN IF NOT EXISTS link_role payment_application_link_role NOT NULL DEFAULT 'counted';
ALTER TABLE payment_applications
  ADD COLUMN IF NOT EXISTS lifecycle payment_application_lifecycle NOT NULL DEFAULT 'confirmed';

-- 3. payment_id becomes nullable (only quickbooks rows carry it) -------------
ALTER TABLE payment_applications
  ALTER COLUMN payment_id DROP NOT NULL;

-- 4. Preserve the quickbooks anchor invariant now that payment_id is nullable
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_applications'::regclass
      AND conname = 'payment_applications_quickbooks_evidence_chk'
  ) THEN
    ALTER TABLE payment_applications
      ADD CONSTRAINT payment_applications_quickbooks_evidence_chk
      CHECK (evidence_source <> 'quickbooks' OR payment_id IS NOT NULL);
  END IF;
END
$$;

-- 5. Partial UNIQUE book-once keys required by the 0086 ON CONFLICT clauses ---
CREATE UNIQUE INDEX IF NOT EXISTS payment_applications_stripe_charge_id_gift_id_uq
  ON payment_applications (stripe_charge_id, gift_id)
  WHERE stripe_charge_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_applications_donorbox_donation_id_gift_id_uq
  ON payment_applications (donorbox_donation_id, gift_id)
  WHERE donorbox_donation_id IS NOT NULL;

-- Verification (run by hand AFTER applying) ---------------------------------
--   -- Columns present + payment_id nullable:
--   SELECT column_name, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'payment_applications'
--     AND column_name IN ('payment_id','link_role','lifecycle')
--   ORDER BY column_name;
--
--   -- Both partial unique book-once indexes exist:
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'payment_applications'
--     AND indexname LIKE '%\_gift\_id\_uq' ESCAPE '\'
--   ORDER BY indexname;
--
--   -- All four evidence/amount checks exist:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'payment_applications'::regclass AND contype = 'c'
--   ORDER BY conname;
