-- Migration 0064: Donorbox donation sync (enrichment + non-Stripe new-money review)
--
-- Adds the schema behind the Donorbox API pull-sync:
--   1. enum  donorbox_exclusion_reason (already_booked | duplicate | not_a_gift | other)
--   2. table donorbox_donations  — one row per Donorbox donation (PK = Donorbox id).
--           Read-only Donorbox facts + a non-Stripe new-money review block that
--           mirrors stripe_staged_charges (status / donor XOR / gift linkage).
--   3. table donorbox_sync_state — singleton run-state + donation_date watermark.
--   4. indexes (incl. the partial-unique stripe_charge_id enrichment join key and
--           the 1:1 donation↔gift link guards).
--
-- WHY A HAND-APPLIED FILE (not relying on the Publish schema diff alone):
--   drizzle-kit push currently ABORTS on a PRE-EXISTING, unrelated drift in this
--   DB (opportunities `conditions_met` tri-state), which would skip ALL additive
--   changes — including these tables. This file applies them idempotently without
--   touching the drifted column. Run it before (or instead of relying on) the
--   Publish diff for these objects.
--
-- SAFETY / IDEMPOTENCY:
--   * Guarded with IF NOT EXISTS / a DO-block enum guard — re-running is a no-op.
--   * Purely additive: creates one enum + two tables + their indexes. Touches no
--     existing table and drops nothing.
--   * The tables start empty; the first Donorbox sync run (scheduled or
--     `pnpm --filter @workspace/api-server run sync:donorbox`) does a full
--     historical pull to populate them.
--
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0064_donorbox_donations.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0064_donorbox_donations.sql   (prod)

BEGIN;

-- 1. Enum type ---------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'donorbox_exclusion_reason') THEN
    CREATE TYPE donorbox_exclusion_reason AS ENUM (
      'already_booked',
      'duplicate',
      'not_a_gift',
      'other'
    );
  END IF;
END
$$;

-- 2. donorbox_donations ------------------------------------------------------
CREATE TABLE IF NOT EXISTS donorbox_donations (
  id                              text PRIMARY KEY,
  donation_type                   text,
  stripe_charge_id                text,
  paypal_transaction_id           text,
  amount                          numeric(14, 2),
  amount_refunded                 numeric(14, 2),
  processing_fee                  numeric(14, 2),
  currency                        text,
  donation_status                 text,
  refunded                        boolean NOT NULL DEFAULT false,
  recurring                       boolean NOT NULL DEFAULT false,
  donated_at                      timestamptz,
  date_received                   date,
  campaign_id                     text,
  campaign_name                   text,
  designation                     text,
  comment                         text,
  anonymous                       boolean NOT NULL DEFAULT false,
  gift_aid                        boolean NOT NULL DEFAULT false,
  donor_name                      text,
  donor_email                     text,
  donor_first_name                text,
  donor_last_name                 text,
  donor_phone                     text,
  donor_employer                  text,
  utm                             jsonb,
  questions                       jsonb,
  raw                             jsonb,
  status                          staged_payment_status NOT NULL DEFAULT 'pending',
  exclusion_reason                donorbox_exclusion_reason,
  match_status                    staged_payment_match_status NOT NULL DEFAULT 'unmatched',
  match_score                     integer,
  match_method                    staged_payment_match_method,
  match_confirmed_by_user_id      text REFERENCES users (id) ON DELETE SET NULL,
  match_confirmed_at              timestamptz,
  organization_id                 text REFERENCES organizations (id) ON DELETE SET NULL,
  individual_giver_person_id      text REFERENCES people (id) ON DELETE SET NULL,
  household_id                    text REFERENCES households (id) ON DELETE SET NULL,
  matched_payment_intermediary_id text REFERENCES payment_intermediaries (id) ON DELETE SET NULL,
  matched_gift_id                 text REFERENCES gifts_and_payments (id) ON DELETE SET NULL,
  created_gift_id                 text REFERENCES gifts_and_payments (id) ON DELETE SET NULL,
  approved_by_user_id             text REFERENCES users (id) ON DELETE SET NULL,
  approved_at                     timestamptz,
  created_at                      timestamp NOT NULL DEFAULT now(),
  updated_at                      timestamp NOT NULL DEFAULT now()
);

-- Enrichment join key — 1:1 with stripe_staged_charges.id when present.
CREATE UNIQUE INDEX IF NOT EXISTS donorbox_donations_stripe_charge_id_uq
  ON donorbox_donations (stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS donorbox_donations_paypal_txn_id_idx
  ON donorbox_donations (paypal_transaction_id);
CREATE INDEX IF NOT EXISTS donorbox_donations_donation_type_idx
  ON donorbox_donations (donation_type);
CREATE INDEX IF NOT EXISTS donorbox_donations_status_idx
  ON donorbox_donations (status);
CREATE INDEX IF NOT EXISTS donorbox_donations_match_status_idx
  ON donorbox_donations (match_status);
CREATE INDEX IF NOT EXISTS donorbox_donations_donated_at_idx
  ON donorbox_donations (donated_at);
CREATE INDEX IF NOT EXISTS donorbox_donations_date_received_idx
  ON donorbox_donations (date_received);
CREATE INDEX IF NOT EXISTS donorbox_donations_amount_idx
  ON donorbox_donations (amount);
CREATE INDEX IF NOT EXISTS donorbox_donations_donor_email_idx
  ON donorbox_donations (donor_email);
CREATE INDEX IF NOT EXISTS donorbox_donations_organization_id_idx
  ON donorbox_donations (organization_id);
CREATE INDEX IF NOT EXISTS donorbox_donations_individual_giver_person_id_idx
  ON donorbox_donations (individual_giver_person_id);
CREATE INDEX IF NOT EXISTS donorbox_donations_household_id_idx
  ON donorbox_donations (household_id);
-- One-to-one donation↔gift linkage (same guard as staged rows).
CREATE UNIQUE INDEX IF NOT EXISTS donorbox_donations_matched_gift_id_uq
  ON donorbox_donations (matched_gift_id)
  WHERE matched_gift_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS donorbox_donations_created_gift_id_uq
  ON donorbox_donations (created_gift_id)
  WHERE created_gift_id IS NOT NULL;

-- 3. donorbox_sync_state -----------------------------------------------------
CREATE TABLE IF NOT EXISTS donorbox_sync_state (
  id                  text PRIMARY KEY,
  donation_cursor     timestamptz,
  last_run_started_at timestamptz,
  last_run_finished_at timestamptz,
  last_status         text,
  last_error          text,
  donations_upserted  integer,
  consecutive_errors  integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Verification:
--   SELECT to_regclass('donorbox_donations'), to_regclass('donorbox_sync_state');
--   SELECT unnest(enum_range(NULL::donorbox_exclusion_reason));  -- already_booked, duplicate, not_a_gift, other
--   SELECT indexname FROM pg_indexes WHERE tablename = 'donorbox_donations' ORDER BY indexname;

COMMIT;
