-- Migration 0062: Stripe refund / chargeback propagation to CRM gifts (INV-13)
--
-- Adds the schema artifacts behind "Propagate Stripe refunds/chargebacks to CRM
-- gifts via propose-then-confirm":
--   1. enum  stripe_refund_propagation_status (none | proposed | applied | dismissed)
--   2. enum  stripe_refund_kind               (full_refund | partial_refund | chargeback)
--   3. cols  stripe_staged_charges.refund_propagation_status   (enum, NOT NULL default 'none')
--           stripe_staged_charges.refund_propagation_kind     (enum, nullable)
--           stripe_staged_charges.refund_propagation_gift_id  (text FK gifts_and_payments ON DELETE SET NULL)
--           stripe_staged_charges.refund_proposed_amount      (numeric(14,2), nullable)
--           stripe_staged_charges.refund_confirmed_by_user_id (text FK users ON DELETE SET NULL)
--           stripe_staged_charges.refund_confirmed_at         (timestamptz, nullable)
--   4. index stripe_staged_charges_refund_propagation_idx (partial: status = 'proposed')
--
-- WHY A HAND-APPLIED FILE (not relying on the Publish schema diff alone):
--   drizzle-kit push currently ABORTS on a PRE-EXISTING, unrelated drift in this
--   DB (opportunities `conditions_met` tri-state), which would skip ALL additive
--   changes — including these columns. This file applies the additive schema
--   changes idempotently without touching the drifted column. Run it before (or
--   instead of relying on) the Publish diff for these objects.
--
-- SAFETY / IDEMPOTENCY:
--   * Guarded with IF NOT EXISTS / DO-block enum guards — re-running is a no-op.
--   * Purely additive: creates two enums + six columns + one index. Touches no
--     existing data and drops nothing.
--   * Every existing row lands at refund_propagation_status = 'none' (the default),
--     so no proposals are raised retroactively; the sync worker raises them going
--     forward as Stripe reports refunds/disputes.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0062_stripe_refund_propagation.sql

BEGIN;

-- 1. Enum types --------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'stripe_refund_propagation_status') THEN
    CREATE TYPE stripe_refund_propagation_status AS ENUM (
      'none',
      'proposed',
      'applied',
      'dismissed'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'stripe_refund_kind') THEN
    CREATE TYPE stripe_refund_kind AS ENUM (
      'full_refund',
      'partial_refund',
      'chargeback'
    );
  END IF;
END
$$;

-- 2. Columns ----------------------------------------------------------------
ALTER TABLE stripe_staged_charges
  ADD COLUMN IF NOT EXISTS refund_propagation_status stripe_refund_propagation_status
    NOT NULL DEFAULT 'none';

ALTER TABLE stripe_staged_charges
  ADD COLUMN IF NOT EXISTS refund_propagation_kind stripe_refund_kind;

ALTER TABLE stripe_staged_charges
  ADD COLUMN IF NOT EXISTS refund_propagation_gift_id text;

ALTER TABLE stripe_staged_charges
  ADD COLUMN IF NOT EXISTS refund_proposed_amount numeric(14, 2);

ALTER TABLE stripe_staged_charges
  ADD COLUMN IF NOT EXISTS refund_confirmed_by_user_id text;

ALTER TABLE stripe_staged_charges
  ADD COLUMN IF NOT EXISTS refund_confirmed_at timestamptz;

-- 3. Foreign keys (added separately so re-runs skip cleanly) -----------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stripe_staged_charges_refund_propagation_gift_id_fk'
  ) THEN
    ALTER TABLE stripe_staged_charges
      ADD CONSTRAINT stripe_staged_charges_refund_propagation_gift_id_fk
      FOREIGN KEY (refund_propagation_gift_id)
      REFERENCES gifts_and_payments (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stripe_staged_charges_refund_confirmed_by_user_id_fk'
  ) THEN
    ALTER TABLE stripe_staged_charges
      ADD CONSTRAINT stripe_staged_charges_refund_confirmed_by_user_id_fk
      FOREIGN KEY (refund_confirmed_by_user_id)
      REFERENCES users (id) ON DELETE SET NULL;
  END IF;
END
$$;

-- 4. Partial index on open proposals ----------------------------------------
CREATE INDEX IF NOT EXISTS stripe_staged_charges_refund_propagation_idx
  ON stripe_staged_charges (refund_propagation_status)
  WHERE refund_propagation_status = 'proposed';

-- Verification:
--   SELECT column_name, data_type, column_default, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'stripe_staged_charges'
--      AND column_name LIKE 'refund_%'
--    ORDER BY column_name;
--   -- Expect refund_propagation_status NOT NULL default 'none'; the rest nullable.
--
--   SELECT unnest(enum_range(NULL::stripe_refund_propagation_status));  -- none, proposed, applied, dismissed
--   SELECT unnest(enum_range(NULL::stripe_refund_kind));                -- full_refund, partial_refund, chargeback

COMMIT;
