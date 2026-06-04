-- Migration 0002: Finalize organizations consolidation (Phase 2)
--
-- Phase 1 (migrate-organizations.ts) copied every funder row + FK into
-- organizations / organization_id but kept the legacy funders table and
-- funder_id columns in place for safety. This migration removes the now
-- redundant legacy structures and brings the DB to the schema's end state:
--   * drops the funders table + all funder_id / funder_ids columns
--   * converts enthusiasm + entity_type from text to their enum types
--   * trims entity_role_type to its 3 live values
--   * re-adds the owner / discriminator / donor-XOR CHECK constraints,
--     now keyed on organization_id
--
-- Idempotent. Apply in a SINGLE transaction:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0002_finalize_organizations.sql

-- 1. Drop donor / contact XOR constraints that still reference funder_id
ALTER TABLE opportunities_and_pledges DROP CONSTRAINT IF EXISTS opportunities_and_pledges_donor_xor;
ALTER TABLE gifts_and_payments        DROP CONSTRAINT IF EXISTS gifts_and_payments_donor_xor;
ALTER TABLE meeting_notes             DROP CONSTRAINT IF EXISTS meeting_notes_contact_xor;

-- 2. Drop all funder_* columns (data already mirrored into organization_* — verified 0 divergence)
ALTER TABLE addresses                 DROP COLUMN IF EXISTS funder_id;
ALTER TABLE emails                    DROP COLUMN IF EXISTS funder_id;
ALTER TABLE phone_numbers             DROP COLUMN IF EXISTS funder_id;
ALTER TABLE people_entity_roles       DROP COLUMN IF EXISTS funder_id;
ALTER TABLE opportunities_and_pledges DROP COLUMN IF EXISTS funder_id;
ALTER TABLE gifts_and_payments        DROP COLUMN IF EXISTS funder_id;
ALTER TABLE meeting_notes             DROP COLUMN IF EXISTS funder_id;
ALTER TABLE email_proposals           DROP COLUMN IF EXISTS target_funder_id;
ALTER TABLE notes                     DROP COLUMN IF EXISTS funder_ids;
ALTER TABLE interactions              DROP COLUMN IF EXISTS funder_ids;
ALTER TABLE tasks                     DROP COLUMN IF EXISTS funder_ids;
ALTER TABLE media_mentions            DROP COLUMN IF EXISTS funder_ids;
ALTER TABLE email_messages            DROP COLUMN IF EXISTS matched_funder_ids;
ALTER TABLE calendar_events           DROP COLUMN IF EXISTS matched_funder_ids;
ALTER TABLE tracked_emails            DROP COLUMN IF EXISTS recipient_funder_ids;

-- 3. Drop the now-redundant funders table (parent_funder_id self-ref goes with it)
DROP TABLE IF EXISTS funders;

-- 4. enthusiasm -> enum
-- 4a. people: drop legacy text col, rename the populated enum col into place
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='people' AND column_name='enthusiasm_enum') THEN
    ALTER TABLE people DROP COLUMN IF EXISTS enthusiasm;
    ALTER TABLE people RENAME COLUMN enthusiasm_enum TO enthusiasm;
  END IF;
END $$;

-- 4b. organizations: convert text -> enthusiasm enum (legacy text -> 7-point map)
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name='organizations' AND column_name='enthusiasm') = 'text' THEN
    ALTER TABLE organizations
      ALTER COLUMN enthusiasm TYPE enthusiasm
      USING (CASE enthusiasm
        WHEN 'advocate'     THEN '7-advocate'
        WHEN 'supportive'   THEN '6-supportive'
        WHEN 'warm'         THEN '5-warm'
        WHEN 'neutral'      THEN '4-neutral'
        WHEN 'cool'         THEN '3-cool'
        WHEN 'unsupportive' THEN '2-unsupportive'
        WHEN 'hostile'      THEN '1-hostile'
        ELSE NULL
      END::enthusiasm);
  END IF;
END $$;

-- 5. entity_type -> enum (create the unified type; convert organizations.entity_type)
DO $$
BEGIN
  IF to_regtype('entity_type') IS NULL THEN
    CREATE TYPE entity_type AS ENUM (
      'family_foundation','institutional_foundation','corporate_foundation','community_foundation',
      'bank_foundation','family_office_trust','intermediary','government','nonprofit','corporation',
      'capital_provider','philanthropic_advisor','cdfi','education_forprofit','competition','public_private',
      'daf_platform','platform','advocacy_membership_lobbyist','authorizer','education_vendor','elected_official',
      'higher_ed','investor','law_firm','media','real_estate','school','school_district','school_network',
      'small_business_consulting','tribal'
    );
  END IF;
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name='organizations' AND column_name='entity_type') = 'text' THEN
    ALTER TABLE organizations ALTER COLUMN entity_type TYPE entity_type USING entity_type::entity_type;
  END IF;
END $$;

-- 6. entity_role_type: drop legacy values (funder, non_funding_organization) -> 3 live values
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
             WHERE t.typname='entity_role_type'
               AND e.enumlabel IN ('funder','non_funding_organization')) THEN
    ALTER TYPE entity_role_type RENAME TO entity_role_type_old;
    CREATE TYPE entity_role_type AS ENUM ('organization','payment_intermediary','household');
    ALTER TABLE people_entity_roles
      ALTER COLUMN entity_type TYPE entity_role_type USING entity_type::text::entity_role_type;
    DROP TYPE entity_role_type_old;
  END IF;
END $$;

-- 7. Re-add owner / discriminator / donor-XOR constraints keyed on organization_id
ALTER TABLE addresses     DROP CONSTRAINT IF EXISTS addresses_exactly_one_owner;
ALTER TABLE addresses     ADD  CONSTRAINT addresses_exactly_one_owner
  CHECK (num_nonnulls(person_id, organization_id, payment_intermediary_id, household_id) = 1);

ALTER TABLE emails        DROP CONSTRAINT IF EXISTS emails_exactly_one_owner;
ALTER TABLE emails        ADD  CONSTRAINT emails_exactly_one_owner
  CHECK (num_nonnulls(person_id, organization_id, payment_intermediary_id, household_id) = 1);

ALTER TABLE phone_numbers DROP CONSTRAINT IF EXISTS phone_numbers_exactly_one_owner;
ALTER TABLE phone_numbers ADD  CONSTRAINT phone_numbers_exactly_one_owner
  CHECK (num_nonnulls(person_id, organization_id, payment_intermediary_id, household_id) = 1);

ALTER TABLE people_entity_roles DROP CONSTRAINT IF EXISTS per_entity_discriminator;
ALTER TABLE people_entity_roles ADD  CONSTRAINT per_entity_discriminator
  CHECK (
    (entity_type = 'organization' AND organization_id IS NOT NULL AND payment_intermediary_id IS NULL AND household_id IS NULL)
    OR (entity_type = 'payment_intermediary' AND payment_intermediary_id IS NOT NULL AND organization_id IS NULL AND household_id IS NULL)
    OR (entity_type = 'household' AND household_id IS NOT NULL AND organization_id IS NULL AND payment_intermediary_id IS NULL)
  );

ALTER TABLE opportunities_and_pledges DROP CONSTRAINT IF EXISTS opportunities_and_pledges_donor_xor;
ALTER TABLE opportunities_and_pledges ADD  CONSTRAINT opportunities_and_pledges_donor_xor
  CHECK (num_nonnulls(organization_id, individual_giver_person_id, household_id) = 1);

ALTER TABLE gifts_and_payments DROP CONSTRAINT IF EXISTS gifts_and_payments_donor_xor;
ALTER TABLE gifts_and_payments ADD  CONSTRAINT gifts_and_payments_donor_xor
  CHECK (num_nonnulls(organization_id, individual_giver_person_id, household_id) = 1);

ALTER TABLE meeting_notes DROP CONSTRAINT IF EXISTS meeting_notes_contact_xor;
ALTER TABLE meeting_notes ADD  CONSTRAINT meeting_notes_contact_xor
  CHECK (num_nonnulls(person_id, organization_id, household_id) = 1);
