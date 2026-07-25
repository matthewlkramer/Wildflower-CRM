-- 0183: drop the legacy source-anchor columns from payment_applications.
--
-- Phase D step 2, DESTRUCTIVE half (bank-spine ADR, docs/adr-bank-spine-money-
-- model.md). `payment_unit_id` is now the sole ledger anchor: every reader,
-- writer, and uniqueness key resolves through it, and `payment_units` carries the
-- source pointers. This retires the three legacy source-anchor columns and every
-- object that depended on them.
--
-- DEPLOY ORDER (see 0183_drop_payment_application_source_anchors_RUNBOOK.md):
--   1. Apply 0182 (additive unit-gift unique) to prod + dev.
--   2. Publish the Phase D step 2 code (stops reading/writing the anchor columns
--      entirely). Both DBs still hold the columns, so the Publish diff is clean.
--   3. Only AFTER the new code is live, apply THIS file to prod, then dev,
--      back-to-back (no Publish between).
--
-- Idempotent: IF EXISTS everywhere.

-- 1. Make the canonical anchor mandatory. Every ledger row already has a unit
--    (0178/0179 backfill + eager creation at booking), so this only pins the
--    invariant.
ALTER TABLE payment_applications
  ALTER COLUMN payment_unit_id SET NOT NULL;

-- 2. Drop the retiring per-anchor uniqueness indexes. The single-column counted
--    per-anchor uniques were already dropped by 0181; these are the remaining
--    counted (anchor, gift) uniques (subsumed by
--    payment_applications_payment_unit_id_counted_uq, 0180) and the corroborating
--    (anchor, gift) partials (subsumed by
--    payment_applications_payment_unit_id_gift_id_corroborating_uq, 0182).
DROP INDEX IF EXISTS payment_applications_payment_id_gift_id_uq;
DROP INDEX IF EXISTS payment_applications_stripe_charge_id_gift_id_uq;
DROP INDEX IF EXISTS payment_applications_donorbox_donation_id_gift_id_uq;
DROP INDEX IF EXISTS payment_applications_payment_id_gift_id_corroborating_uq;
DROP INDEX IF EXISTS payment_applications_stripe_charge_id_gift_id_corroborating_uq;

-- 3. Drop the plain lookup indexes on the anchor columns.
DROP INDEX IF EXISTS payment_applications_payment_id_idx;
DROP INDEX IF EXISTS payment_applications_stripe_charge_id_idx;
DROP INDEX IF EXISTS payment_applications_donorbox_donation_id_idx;

-- 4. Drop the per-source "must carry its anchor id" CHECK constraints.
ALTER TABLE payment_applications
  DROP CONSTRAINT IF EXISTS payment_applications_quickbooks_evidence_chk;
ALTER TABLE payment_applications
  DROP CONSTRAINT IF EXISTS payment_applications_stripe_evidence_chk;
ALTER TABLE payment_applications
  DROP CONSTRAINT IF EXISTS payment_applications_donorbox_evidence_chk;

-- 5. Drop the columns (their FK constraints drop with them).
ALTER TABLE payment_applications
  DROP COLUMN IF EXISTS payment_id;
ALTER TABLE payment_applications
  DROP COLUMN IF EXISTS stripe_charge_id;
ALTER TABLE payment_applications
  DROP COLUMN IF EXISTS donorbox_donation_id;
