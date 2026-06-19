-- Migration 0050: Finance Reconciliation — manual entity-attribution override
--
-- Lets fundraisers ASSIGN or CORRECT which Wildflower legal entity a staged
-- QuickBooks payment belongs to, straight from the Finance Reconciliation queue.
-- The choice must persist and survive re-sync (treated as a manual override, not
-- overwritten by detectEntity). Two real cases drive this: "Sunlight" money
-- (intentionally not auto-attributed) and broad-substring misattributions that
-- need correcting.
--
-- Adds (mirrors the existing staged_payments.classification_source pattern, but
-- ORTHOGONAL to it — entity attribution is separate from exclusion):
--   * enum    staged_payment_entity_source ('auto' | 'manual')
--   * column  staged_payments.entity_source  NOT NULL DEFAULT 'auto'
--
-- A row with entity_source = 'manual' has had its entity pinned by a human; the
-- ingest upsert and reclassifyStagedPayments both leave such a row's entity_id
-- untouched (detectEntity never clobbers a manual attribution). Clearing the
-- entity to NULL still pins manual, so "Sunlight" money stays unattributed across
-- re-syncs.
--
-- ORDER: run this BEFORE deploying the new app code (the set-entity route and the
-- sync/reclassify guards read/write entity_source). The schema also reaches
-- production via the normal Publish (drizzle) diff; this file is the human-applied
-- equivalent and is safe to run before OR after a Publish.
--
-- Non-destructive + idempotent: guarded CREATE TYPE / ADD COLUMN IF NOT EXISTS.
-- Existing rows default to 'auto' (their attribution is still detectEntity-owned).
-- A second run is a no-op; no existing data is touched.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0050_staged_payment_entity_source.sql

BEGIN;

-- Entity-source enum (guarded — CREATE TYPE has no IF NOT EXISTS).
DO $$ BEGIN
  CREATE TYPE staged_payment_entity_source AS ENUM ('auto', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS entity_source staged_payment_entity_source
    NOT NULL DEFAULT 'auto';

-- Verification:
--   SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
--   WHERE t.typname = 'staged_payment_entity_source';        -- 'auto', 'manual'
--   SELECT column_name, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'staged_payments' AND column_name = 'entity_source';

COMMIT;
