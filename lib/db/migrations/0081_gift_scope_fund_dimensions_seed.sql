-- Migration 0081: Gift-scope restructure (Task #448) — seed the new fund
-- dimensions + the entity no-payment flag.
--
-- Part of moving gift scope/reconciliation state OFF the gifts_and_payments
-- header onto child gift_allocations rows (or values derived from linked
-- payments). Two header booleans become allocation ENTITY choices:
--   * designated_to_school     → the "Direct to School" entity
--   * off_books_fiscal_sponsor → the "Wildflower Foundation TSNE" entity
-- and "payment expected" is DERIVED: a gift expects payment unless ALL of its
-- allocations sit on a no-payment entity (entities.expects_payment = false).
--
-- This file brings PRODUCTION DATA in line with that code change. The SCHEMA
-- itself (entities.expects_payment) reaches production via the normal Publish
-- (drizzle) diff; this file only seeds DATA and MUST run AFTER that Publish (it
-- writes entities.expects_payment, which Publish creates).
--
-- WHAT IT DOES (all idempotent):
--   1. Adds entities.expects_payment defensively (IF NOT EXISTS) so the file is
--      safe to run even if applied before the Publish diff lands. Default true.
--   2. Seeds the two no-payment entities ("Direct to School", "Wildflower
--      Foundation TSNE") with expects_payment = false, and ensures the
--      "Wildflower Foundation" default bucket exists.
--   3. Seeds the "Seed Fund" fundable project (target for the school-startup
--      designation backfill in a later migration).
--
-- IDEMPOTENCY / SAFETY:
--   * Column add is IF NOT EXISTS.
--   * Entity / fundable-project seeds use ON CONFLICT (id) DO NOTHING (never
--     overwrite an existing name).
--   * The expects_payment correction is guarded (only flips the two no-payment
--     entities, only when not already false), so a re-run is a no-op.
--   * No row is ever deleted; this is purely additive.
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0081_gift_scope_fund_dimensions_seed.sql

-- 1. Defensive column add (Publish normally creates this; harmless if present).
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS expects_payment boolean NOT NULL DEFAULT true;

-- 2. Seed the no-payment entities + ensure the Foundation default bucket exists.
INSERT INTO entities (id, name, active, expects_payment) VALUES
  ('wildflower_foundation',      'Wildflower Foundation',     true, true),
  ('direct_to_school',           'Direct to School',          true, false),
  ('wildflower_foundation_tsne', 'Wildflower Foundation TSNE', true, false)
ON CONFLICT (id) DO NOTHING;

-- Ensure the two no-payment entities carry expects_payment = false even if they
-- pre-existed from an earlier partial run (guarded — no-op once already false).
UPDATE entities
   SET expects_payment = false, updated_at = now()
 WHERE id IN ('direct_to_school', 'wildflower_foundation_tsne')
   AND expects_payment IS DISTINCT FROM false;

-- 3. Seed the Seed Fund fundable project (school-startup designation target).
INSERT INTO fundable_projects (id, name, active) VALUES
  ('seed_fund', 'Seed Fund', true)
ON CONFLICT (id) DO NOTHING;

-- Report post-state for the operator (non-aborting).
DO $$
DECLARE
  n_no_payment int;
  n_seed_fund  int;
BEGIN
  SELECT count(*) INTO n_no_payment
    FROM entities
   WHERE id IN ('direct_to_school', 'wildflower_foundation_tsne')
     AND expects_payment = false;
  SELECT count(*) INTO n_seed_fund
    FROM fundable_projects WHERE id = 'seed_fund';
  RAISE NOTICE '0081: no-payment entities=% (expect 2), seed_fund project=% (expect 1)',
    n_no_payment, n_seed_fund;
END $$;
