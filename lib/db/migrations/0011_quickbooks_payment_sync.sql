-- Migration 0011: QuickBooks Online → CRM one-way payment sync
--
-- Adds the schema backing the QuickBooks payment-sync feature:
--   * enums   quickbooks_entity_type / staged_payment_status /
--             staged_payment_match_status
--   * table   quickbooks_connections — the single org-wide QuickBooks company
--             grant (tokens encrypted-at-rest), keyed by realmId
--   * table   staged_payments — the review queue of incoming-money records
--             pulled from QuickBooks (SalesReceipt / Payment / Deposit), each
--             auto-matched to a CRM donor (XOR) and approved into a real
--             gifts_and_payments row
--
-- Enum values are snake_case to match the Drizzle pgEnum definitions and the
-- normalized client output (sales_receipt / payment / deposit); match_status is
-- only matched / unmatched (the matcher never emits an "ambiguous" state — an
-- ambiguous candidate set stays unmatched for a human to resolve).
--
-- This migration is ADDITIVE and non-destructive: new enums + new tables only.
-- Idempotent: enum creation is guarded; all CREATE ... use IF NOT EXISTS.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0011_quickbooks_payment_sync.sql

BEGIN;

-- ─── Enums (guarded — CREATE TYPE has no IF NOT EXISTS) ─────────────────────
DO $$ BEGIN
  CREATE TYPE quickbooks_entity_type AS ENUM ('sales_receipt', 'payment', 'deposit');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE staged_payment_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE staged_payment_match_status AS ENUM ('matched', 'unmatched');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── quickbooks_connections ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quickbooks_connections (
  realm_id            text PRIMARY KEY,
  company_name        text,
  access_token_enc    text,
  refresh_token_enc   text,
  scope               text,
  expires_at          timestamptz,
  granted_at          timestamptz,
  revoked_at          timestamptz,
  connected_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  sync_watermark      timestamptz,
  last_synced_at      timestamptz,
  last_error          text,
  created_at          timestamp NOT NULL DEFAULT now(),
  updated_at          timestamp NOT NULL DEFAULT now()
);

-- ─── staged_payments ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staged_payments (
  id                          text PRIMARY KEY,
  realm_id                    text NOT NULL,
  qb_entity_type              quickbooks_entity_type NOT NULL,
  qb_entity_id                text NOT NULL,
  amount                      numeric(14, 2),
  date_received               date,
  payer_name                  text,
  payer_email                 text,
  raw_reference               text,
  status                      staged_payment_status NOT NULL DEFAULT 'pending',
  match_status                staged_payment_match_status NOT NULL DEFAULT 'unmatched',
  organization_id             text REFERENCES organizations(id) ON DELETE SET NULL,
  individual_giver_person_id  text REFERENCES people(id) ON DELETE SET NULL,
  household_id                text REFERENCES households(id) ON DELETE SET NULL,
  created_gift_id             text REFERENCES gifts_and_payments(id) ON DELETE SET NULL,
  approved_by_user_id         text REFERENCES users(id) ON DELETE SET NULL,
  approved_at                 timestamptz,
  rejected_by_user_id         text REFERENCES users(id) ON DELETE SET NULL,
  rejected_at                 timestamptz,
  created_at                  timestamp NOT NULL DEFAULT now(),
  updated_at                  timestamp NOT NULL DEFAULT now()
);

-- Idempotency: a single QB entity (per company, per type) maps to exactly one
-- staged row, so re-syncing never duplicates the queue or the resulting gift.
CREATE UNIQUE INDEX IF NOT EXISTS staged_payments_qb_entity_uq
  ON staged_payments(realm_id, qb_entity_type, qb_entity_id);

CREATE INDEX IF NOT EXISTS staged_payments_status_idx
  ON staged_payments(status);
CREATE INDEX IF NOT EXISTS staged_payments_organization_id_idx
  ON staged_payments(organization_id);
CREATE INDEX IF NOT EXISTS staged_payments_individual_giver_person_id_idx
  ON staged_payments(individual_giver_person_id);
CREATE INDEX IF NOT EXISTS staged_payments_household_id_idx
  ON staged_payments(household_id);

-- Verification:
--   SELECT to_regclass('quickbooks_connections'), to_regclass('staged_payments');
--   -- both should be non-null
--   SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
--   WHERE t.typname = 'quickbooks_entity_type';  -- sales_receipt / payment / deposit

COMMIT;
