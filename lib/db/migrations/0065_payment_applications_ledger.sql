-- Migration 0065: QuickBooks cash-application ledger (payment_applications)
--
-- Adds the authoritative many-to-many ledger between QB payment records
-- (staged_payments) and the CRM gifts (gifts_and_payments) they settle:
--   1. enums  payment_application_evidence_source (quickbooks | stripe | donorbox)
--             payment_application_match_method     (system | system_confirmed | human)
--   2. table  payment_applications — one row per payment↔gift booking
--             (header grain; amount_applied; evidence source + optional
--             stripe_charge_id / donorbox_donation_id; mint-ownership flag).
--   3. indexes — the UNIQUE(payment_id, gift_id) book-once key + lookup indexes.
--
-- ROLLOUT: this is PHASE 1 (additive only). The table starts EMPTY — no code
-- writes to it yet and no reads depend on it. Dual-write + backfill land in a
-- later phase, behind their own reviewed SQL file.
--
-- WHY A HAND-APPLIED FILE (not relying on the Publish schema diff alone):
--   drizzle-kit push currently ABORTS on a pre-existing, unrelated drift in this
--   DB (opportunities `conditions_met` tri-state), which would skip ALL additive
--   changes — including this table. This file applies them idempotently without
--   touching the drifted column. Run it before (or instead of relying on) the
--   Publish diff for these objects.
--
-- ORDERING: requires staged_payments, gifts_and_payments, users,
--   stripe_staged_charges, and donorbox_donations (migration 0064) to already
--   exist. Apply AFTER 0064 / after Publish has created donorbox_donations.
--
-- SAFETY / IDEMPOTENCY:
--   * Guarded with IF NOT EXISTS / DO-block enum guards — re-running is a no-op.
--   * Purely additive: creates two enums + one table + its indexes. Touches no
--     existing table and drops nothing.
--   * Both gift_id and payment_id FKs are ON DELETE RESTRICT (the QB record and
--     the gift are both anchors). Since the table starts empty, the RESTRICT
--     FKs cannot block any existing delete; the app's gift hard-delete paths
--     already clear/guard on these rows for the dual-write phase.
--
-- Apply with psql -1 (it wraps the whole file in ONE transaction; do NOT add a
-- BEGIN/COMMIT here or it nests and warns):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0065_payment_applications_ledger.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0065_payment_applications_ledger.sql   (prod)

-- 1. Enum types -------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_application_evidence_source') THEN
    CREATE TYPE payment_application_evidence_source AS ENUM (
      'quickbooks',
      'stripe',
      'donorbox'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_application_match_method') THEN
    CREATE TYPE payment_application_match_method AS ENUM (
      'system',
      'system_confirmed',
      'human'
    );
  END IF;
END
$$;

-- 2. payment_applications ---------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_applications (
  id                   text PRIMARY KEY,
  payment_id           text NOT NULL REFERENCES staged_payments (id) ON DELETE RESTRICT,
  gift_id              text NOT NULL REFERENCES gifts_and_payments (id) ON DELETE RESTRICT,
  amount_applied       numeric(14, 2) NOT NULL,
  evidence_source      payment_application_evidence_source NOT NULL,
  stripe_charge_id     text REFERENCES stripe_staged_charges (id) ON DELETE SET NULL,
  donorbox_donation_id text REFERENCES donorbox_donations (id) ON DELETE SET NULL,
  match_method         payment_application_match_method NOT NULL DEFAULT 'system',
  confirmed_by_user_id text REFERENCES users (id) ON DELETE SET NULL,
  confirmed_at         timestamp,
  note                 text,
  created_the_gift     boolean NOT NULL DEFAULT false,
  created_at           timestamp NOT NULL DEFAULT now(),
  updated_at           timestamp NOT NULL DEFAULT now(),
  CONSTRAINT payment_applications_amount_applied_positive
    CHECK (amount_applied > 0),
  CONSTRAINT payment_applications_stripe_evidence_chk
    CHECK (evidence_source <> 'stripe' OR stripe_charge_id IS NOT NULL),
  CONSTRAINT payment_applications_donorbox_evidence_chk
    CHECK (evidence_source <> 'donorbox' OR donorbox_donation_id IS NOT NULL)
);

-- 3. Indexes ----------------------------------------------------------------
-- Book-once key: a payment is booked to a gift exactly once.
CREATE UNIQUE INDEX IF NOT EXISTS payment_applications_payment_id_gift_id_uq
  ON payment_applications (payment_id, gift_id);
CREATE INDEX IF NOT EXISTS payment_applications_gift_id_idx
  ON payment_applications (gift_id);
CREATE INDEX IF NOT EXISTS payment_applications_payment_id_idx
  ON payment_applications (payment_id);
CREATE INDEX IF NOT EXISTS payment_applications_stripe_charge_id_idx
  ON payment_applications (stripe_charge_id);
CREATE INDEX IF NOT EXISTS payment_applications_donorbox_donation_id_idx
  ON payment_applications (donorbox_donation_id);

-- Verification:
--   SELECT to_regclass('payment_applications');
--   SELECT unnest(enum_range(NULL::payment_application_evidence_source));  -- quickbooks, stripe, donorbox
--   SELECT unnest(enum_range(NULL::payment_application_match_method));     -- system, system_confirmed, human
--   SELECT indexname FROM pg_indexes WHERE tablename = 'payment_applications' ORDER BY indexname;
--   SELECT conname FROM pg_constraint WHERE conrelid = 'payment_applications'::regclass ORDER BY conname;
