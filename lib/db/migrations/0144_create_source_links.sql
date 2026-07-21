-- 0144: Create the source_links evidence↔evidence claim ledger (ADR:
-- docs/adr-source-link-ledger.md) + extend payment_application_match_method
-- with 'charge_tie_supersede'.
--
-- PURELY ADDITIVE, idempotent. Publish also creates these objects from the
-- schema diff; this file is the reviewable record and the dev-DB apply path
-- (drizzle push cannot answer its enum-rename prompt non-interactively).
--
-- Apply (from repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0144_create_source_links.sql
--
-- NOTE: the new 'charge_tie_supersede' enum value CANNOT be referenced in the
-- same transaction that adds it — the backfill that uses it is the SEPARATE
-- file 0145_backfill_source_links.sql. Run 0144, then 0145.
--
-- PRE-FLIGHT (ADR phase 1): before applying to prod, run the read-only
-- double-claim report in 0144_RUNBOOK.md and resolve any rows it returns
-- (expected: zero).

-- ── Enums ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "source_link_type" AS ENUM
    ('charge_qb_tie', 'charge_fee_row', 'donorbox_qb', 'donorbox_charge');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "source_link_lifecycle" AS ENUM ('proposed', 'confirmed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "source_link_provenance" AS ENUM
    ('system', 'system_confirmed', 'human');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "payment_application_match_method"
  ADD VALUE IF NOT EXISTS 'charge_tie_supersede';

-- ── Table ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "source_links" (
  "id" text PRIMARY KEY,
  "link_type" "source_link_type" NOT NULL,
  "stripe_charge_id" text
    REFERENCES "stripe_staged_charges"("id") ON DELETE CASCADE,
  "qb_staged_payment_id" text
    REFERENCES "staged_payments"("id") ON DELETE CASCADE,
  "donorbox_donation_id" text
    REFERENCES "donorbox_donations"("id") ON DELETE CASCADE,
  "lifecycle" "source_link_lifecycle" NOT NULL,
  "provenance" "source_link_provenance" NOT NULL DEFAULT 'system',
  "confirmed_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "confirmed_at" timestamp with time zone,
  "note" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "source_links_fk_shape_chk" CHECK ((
    ("link_type" = 'charge_qb_tie'   AND "stripe_charge_id" IS NOT NULL AND "qb_staged_payment_id" IS NOT NULL AND "donorbox_donation_id" IS NULL) OR
    ("link_type" = 'charge_fee_row'  AND "stripe_charge_id" IS NOT NULL AND "qb_staged_payment_id" IS NOT NULL AND "donorbox_donation_id" IS NULL) OR
    ("link_type" = 'donorbox_qb'     AND "donorbox_donation_id" IS NOT NULL AND "qb_staged_payment_id" IS NOT NULL AND "stripe_charge_id" IS NULL) OR
    ("link_type" = 'donorbox_charge' AND "donorbox_donation_id" IS NOT NULL AND "stripe_charge_id" IS NOT NULL AND "qb_staged_payment_id" IS NULL)
  )),
  CONSTRAINT "source_links_proposed_tie_only_chk" CHECK (
    "lifecycle" = 'confirmed' OR "link_type" = 'charge_qb_tie'
  )
);

-- ── Cardinality (partial unique indexes per ADR §2) ─────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "source_links_charge_tie_charge_uq"
  ON "source_links" ("stripe_charge_id")
  WHERE "link_type" = 'charge_qb_tie';
CREATE UNIQUE INDEX IF NOT EXISTS "source_links_charge_tie_qb_confirmed_uq"
  ON "source_links" ("qb_staged_payment_id")
  WHERE "link_type" = 'charge_qb_tie' AND "lifecycle" = 'confirmed';
CREATE UNIQUE INDEX IF NOT EXISTS "source_links_fee_row_charge_uq"
  ON "source_links" ("stripe_charge_id")
  WHERE "link_type" = 'charge_fee_row';
CREATE UNIQUE INDEX IF NOT EXISTS "source_links_donorbox_qb_uq"
  ON "source_links" ("donorbox_donation_id")
  WHERE "link_type" = 'donorbox_qb';
CREATE UNIQUE INDEX IF NOT EXISTS "source_links_donorbox_charge_uq"
  ON "source_links" ("donorbox_donation_id")
  WHERE "link_type" = 'donorbox_charge';

-- ── Lookup indexes ───────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "source_links_qb_staged_payment_id_idx"
  ON "source_links" ("qb_staged_payment_id");
CREATE INDEX IF NOT EXISTS "source_links_stripe_charge_id_idx"
  ON "source_links" ("stripe_charge_id");
CREATE INDEX IF NOT EXISTS "source_links_donorbox_donation_id_idx"
  ON "source_links" ("donorbox_donation_id");
CREATE INDEX IF NOT EXISTS "source_links_link_type_lifecycle_idx"
  ON "source_links" ("link_type", "lifecycle");
