-- Migration 0008: donor_payment_intermediaries ("gives through") join table
--
-- A donor's explicit, loggable "gives through" link to a payment intermediary
-- (e.g. a DAF), unified across all three donor types via the same donor-XOR
-- convention used by gifts_and_payments / opportunities_and_pledges. Replaces
-- the single-FK organizations.payment_intermediary_id model with a many-to-many
-- table that also covers individuals and households.
--
-- This migration is ADDITIVE and non-destructive:
--   * creates the table + indexes + donor-XOR CHECK
--   * backfills existing organizations.payment_intermediary_id values as
--     organization-typed links (deterministic id 'dpi_org_<orgId>' so a re-run
--     is a no-op)
-- It deliberately does NOT drop organizations.payment_intermediary_id. That
-- column is retained (read-only / deprecated) and should be dropped only by a
-- LATER, separately reviewed migration once the new table is confirmed in prod.
--
-- Idempotent: CREATE ... IF NOT EXISTS throughout; the backfill uses
-- deterministic PKs + ON CONFLICT DO NOTHING.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0008_donor_payment_intermediaries.sql

BEGIN;

CREATE TABLE IF NOT EXISTS donor_payment_intermediaries (
  id text PRIMARY KEY,
  payment_intermediary_id text NOT NULL
    REFERENCES payment_intermediaries(id) ON DELETE CASCADE,
  organization_id text REFERENCES organizations(id) ON DELETE CASCADE,
  individual_giver_person_id text REFERENCES people(id) ON DELETE CASCADE,
  household_id text REFERENCES households(id) ON DELETE CASCADE,
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT dpi_donor_xor
    CHECK (num_nonnulls(organization_id, individual_giver_person_id, household_id) = 1)
);

CREATE INDEX IF NOT EXISTS donor_payment_intermediaries_payment_intermediary_id_idx
  ON donor_payment_intermediaries(payment_intermediary_id);
CREATE INDEX IF NOT EXISTS donor_payment_intermediaries_organization_id_idx
  ON donor_payment_intermediaries(organization_id);
CREATE INDEX IF NOT EXISTS donor_payment_intermediaries_individual_giver_person_id_idx
  ON donor_payment_intermediaries(individual_giver_person_id);
CREATE INDEX IF NOT EXISTS donor_payment_intermediaries_household_id_idx
  ON donor_payment_intermediaries(household_id);

-- Dedupe (donor, intermediary) per donor type. Partial because only one donor
-- FK is non-null per row.
CREATE UNIQUE INDEX IF NOT EXISTS dpi_unique_org_pi
  ON donor_payment_intermediaries(organization_id, payment_intermediary_id)
  WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dpi_unique_person_pi
  ON donor_payment_intermediaries(individual_giver_person_id, payment_intermediary_id)
  WHERE individual_giver_person_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dpi_unique_household_pi
  ON donor_payment_intermediaries(household_id, payment_intermediary_id)
  WHERE household_id IS NOT NULL;

-- Backfill the legacy single-FK org -> intermediary links.
INSERT INTO donor_payment_intermediaries (id, payment_intermediary_id, organization_id)
SELECT 'dpi_org_' || o.id, o.payment_intermediary_id, o.id
FROM organizations o
WHERE o.payment_intermediary_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Verification:
--   SELECT count(*) FILTER (WHERE organization_id IS NOT NULL) AS org_links,
--          (SELECT count(*) FROM organizations WHERE payment_intermediary_id IS NOT NULL) AS orgs_with_fk
--   FROM donor_payment_intermediaries;  -- org_links should equal orgs_with_fk

COMMIT;
