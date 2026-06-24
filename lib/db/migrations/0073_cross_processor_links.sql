-- Migration 0073: Cross-processor reconciliation link columns (additive schema only)
--
-- The Reconciliation Workbench needs to persist a HUMAN-CONFIRMED tie directly
-- between the three money sources (QuickBooks / Stripe / Donorbox) so the same
-- physical money can be linked once and never re-derived from the settlement
-- graph on every read. These columns are purely additive provenance: they NEVER
-- mint or mutate a gift and are NEVER written back to any processor (pull-only).
--
-- Adds (all NULLABLE, no default -- every existing row stays NULL):
--   1. stripe_staged_charges.linked_qb_staged_payment_id      -> staged_payments(id)
--      (per-charge QB<->Stripe tie, finer than the payout-level
--       stripe_payouts.matched_qb_staged_payment_id)
--   2. stripe_staged_charges.cross_processor_linked_by_user_id -> users(id)
--   3. stripe_staged_charges.cross_processor_linked_at         timestamptz
--   4. donorbox_donations.linked_qb_staged_payment_id         -> staged_payments(id)
--      (covers non-Stripe Donorbox money -- PayPal/ACH -- that lands in a QB
--       bank deposit and has no pulled processor join key)
--   5. donorbox_donations.linked_stripe_charge_id             -> stripe_staged_charges(id)
--      (human-CONFIRMED counterpart to the read-only PULLED stripe_charge_id)
--   6. donorbox_donations.cross_processor_linked_by_user_id   -> users(id)
--   7. donorbox_donations.cross_processor_linked_at           timestamptz
--   + lookup indexes on the new FK columns.
--
-- WHY A HAND-APPLIED FILE (not relying on the Publish schema diff alone):
--   drizzle-kit push / the Publish diff can ABORT on a PRE-EXISTING, unrelated
--   drift in the live DB (e.g. the opportunities_and_pledges was_pledge/paid
--   rename), which would skip ALL additive changes -- including these columns.
--   This file applies them idempotently without touching any drifted column.
--   Run it before (or instead of relying on) the Publish diff.
--
-- SAFETY / IDEMPOTENCY:
--   * IF NOT EXISTS columns + pg_constraint-guarded FKs + IF NOT EXISTS indexes
--     -- re-running is a clean no-op.
--   * Purely additive: seven NULLABLE columns + two indexes. Touches no existing
--     data, drops nothing.
--
-- Apply with psql -1 (it wraps the whole file in ONE transaction; do NOT add a
-- top-level BEGIN/COMMIT here or it nests and warns):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0073_cross_processor_links.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0073_cross_processor_links.sql   (prod)

-- 1. stripe_staged_charges columns ------------------------------------------
ALTER TABLE stripe_staged_charges
  ADD COLUMN IF NOT EXISTS linked_qb_staged_payment_id text;
ALTER TABLE stripe_staged_charges
  ADD COLUMN IF NOT EXISTS cross_processor_linked_by_user_id text;
ALTER TABLE stripe_staged_charges
  ADD COLUMN IF NOT EXISTS cross_processor_linked_at timestamptz;

-- 2. donorbox_donations columns ---------------------------------------------
ALTER TABLE donorbox_donations
  ADD COLUMN IF NOT EXISTS linked_qb_staged_payment_id text;
ALTER TABLE donorbox_donations
  ADD COLUMN IF NOT EXISTS linked_stripe_charge_id text;
ALTER TABLE donorbox_donations
  ADD COLUMN IF NOT EXISTS cross_processor_linked_by_user_id text;
ALTER TABLE donorbox_donations
  ADD COLUMN IF NOT EXISTS cross_processor_linked_at timestamptz;

-- 3. Foreign keys (added separately so re-runs skip cleanly) -----------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stripe_staged_charges_linked_qb_staged_payment_id_fk'
  ) THEN
    ALTER TABLE stripe_staged_charges
      ADD CONSTRAINT stripe_staged_charges_linked_qb_staged_payment_id_fk
      FOREIGN KEY (linked_qb_staged_payment_id)
      REFERENCES staged_payments (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stripe_staged_charges_cross_processor_linked_by_user_id_fk'
  ) THEN
    ALTER TABLE stripe_staged_charges
      ADD CONSTRAINT stripe_staged_charges_cross_processor_linked_by_user_id_fk
      FOREIGN KEY (cross_processor_linked_by_user_id)
      REFERENCES users (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'donorbox_donations_linked_qb_staged_payment_id_fk'
  ) THEN
    ALTER TABLE donorbox_donations
      ADD CONSTRAINT donorbox_donations_linked_qb_staged_payment_id_fk
      FOREIGN KEY (linked_qb_staged_payment_id)
      REFERENCES staged_payments (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'donorbox_donations_linked_stripe_charge_id_fk'
  ) THEN
    ALTER TABLE donorbox_donations
      ADD CONSTRAINT donorbox_donations_linked_stripe_charge_id_fk
      FOREIGN KEY (linked_stripe_charge_id)
      REFERENCES stripe_staged_charges (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'donorbox_donations_cross_processor_linked_by_user_id_fk'
  ) THEN
    ALTER TABLE donorbox_donations
      ADD CONSTRAINT donorbox_donations_cross_processor_linked_by_user_id_fk
      FOREIGN KEY (cross_processor_linked_by_user_id)
      REFERENCES users (id) ON DELETE SET NULL;
  END IF;
END
$$;

-- 4. Lookup indexes on the new FK columns -----------------------------------
CREATE INDEX IF NOT EXISTS stripe_staged_charges_linked_qb_staged_payment_id_idx
  ON stripe_staged_charges (linked_qb_staged_payment_id);
CREATE INDEX IF NOT EXISTS donorbox_donations_linked_qb_staged_payment_id_idx
  ON donorbox_donations (linked_qb_staged_payment_id);
CREATE INDEX IF NOT EXISTS donorbox_donations_linked_stripe_charge_id_idx
  ON donorbox_donations (linked_stripe_charge_id);

-- Verification:
--   SELECT table_name, column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE column_name IN (
--            'linked_qb_staged_payment_id', 'linked_stripe_charge_id',
--            'cross_processor_linked_by_user_id', 'cross_processor_linked_at')
--    ORDER BY table_name, column_name;
--   -- Expect 7 rows across stripe_staged_charges (3) + donorbox_donations (4),
--   -- all is_nullable YES.
