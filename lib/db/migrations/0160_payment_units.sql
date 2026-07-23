-- 0160: create payment_units — the canonical donor-level payment unit
-- (docs/adr-bank-spine-money-model.md, Phase 2), and backfill it 1:1 from
-- non-excluded Stripe charges.
--
-- One payment_units row = one real donor-level payment event. This is the
-- single anchor the gift-application ledger re-anchors onto in Phase 5. It
-- carries NO donor identity / coding (those stay on the gift) and NO parent
-- pointer (a charge's parent is its payout; a check's is a
-- bank_deposit_components row).
--
-- BACKFILL: one unit per stripe_staged_charges row with exclusion_reason IS NULL
-- (excluded charges are non-gift money and never enter the counted ledger, so
-- they get no unit). Deterministic id `pu_<charge id>` → idempotent.
-- Check units + their components are backfilled separately in Phase 3.
--
-- WHY SAFE: additive only (one table + two enums + indexes, all idempotent) plus
-- an idempotent backfill (ON CONFLICT (id) DO NOTHING). No existing table is
-- touched; nothing reads payment_units yet. Re-runnable.
--
-- Run (human, repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0160_payment_units.sql

DO $$ BEGIN
  CREATE TYPE payment_unit_kind AS ENUM ('stripe_charge', 'check', 'direct_ach', 'wire', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_unit_lifecycle AS ENUM ('received', 'partially_refunded', 'refunded', 'disputed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS payment_units (
  id text PRIMARY KEY,
  kind payment_unit_kind NOT NULL,
  stripe_charge_id text REFERENCES stripe_staged_charges(id) ON DELETE RESTRICT,
  donorbox_donation_id text REFERENCES donorbox_donations(id) ON DELETE SET NULL,
  source_staged_payment_id text REFERENCES staged_payments(id) ON DELETE SET NULL,
  gross_amount numeric(14, 2),
  fee_amount numeric(14, 2),
  net_amount numeric(14, 2),
  currency text NOT NULL DEFAULT 'USD',
  received_date date,
  lifecycle payment_unit_lifecycle NOT NULL DEFAULT 'received',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT payment_units_stripe_charge_shape_chk
    CHECK ((kind = 'stripe_charge') = (stripe_charge_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_units_stripe_charge_id_uq
  ON payment_units (stripe_charge_id) WHERE stripe_charge_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_units_donorbox_donation_id_uq
  ON payment_units (donorbox_donation_id) WHERE donorbox_donation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_units_kind_idx ON payment_units (kind);
CREATE INDEX IF NOT EXISTS payment_units_source_staged_payment_id_idx
  ON payment_units (source_staged_payment_id);
CREATE INDEX IF NOT EXISTS payment_units_received_date_idx ON payment_units (received_date);

-- Backfill: one payment unit per non-excluded Stripe charge.
INSERT INTO payment_units (
  id, kind, stripe_charge_id, gross_amount, fee_amount, net_amount,
  currency, received_date, lifecycle
)
SELECT
  'pu_' || sc.id,
  'stripe_charge',
  sc.id,
  sc.gross_amount,
  sc.fee_amount,
  sc.net_amount,
  -- Stripe stores lowercase ('usd'); normalize to uppercase so payment_units
  -- and bank_deposits agree and joins/comparisons never need case-folding.
  upper(COALESCE(sc.currency, 'USD')),
  sc.date_received,
  CASE
    WHEN sc.disputed THEN 'disputed'
    WHEN sc.refunded THEN 'refunded'
    WHEN sc.amount_refunded IS NOT NULL AND sc.amount_refunded > 0 THEN 'partially_refunded'
    ELSE 'received'
  END::payment_unit_lifecycle
FROM stripe_staged_charges sc
WHERE sc.exclusion_reason IS NULL
ON CONFLICT (id) DO NOTHING;
