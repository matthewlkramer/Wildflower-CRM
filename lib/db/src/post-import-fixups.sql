-- Post-import fixups
--
-- Manual data corrections applied on top of the Airtable importer output that
-- are NOT recreated by re-running `import-airtable.mjs`. Run AFTER the importer
-- if rebuilding the DB from Airtable (note: Airtable base is being archived, so
-- the importer itself is also frozen and won't pick up changes made after that).
--
-- Every statement must be idempotent. Use `WHERE` guards or `ON CONFLICT` so
-- re-running this file is safe. Schema-level changes (new columns, enum values,
-- CHECK constraints) live in the Drizzle schema and are applied by
-- `pnpm --filter @workspace/db run push`; only DATA corrections belong here.
--
-- Add new fixups at the bottom with a date + short rationale comment.

BEGIN;

-- ============================================================================
-- 2026-05  Household-as-donor reclassifications (62 rows for 14 couples)
-- ============================================================================
-- See "household_id donor option" in session notes. Each couple's
-- gifts + opps moved from individual_giver_person_id to household_id, with
-- primary_contact_person_id preserving the lead person. Specific row updates
-- were applied via batched SQL in the session; the household FK + index +
-- CHECK constraint live in the Drizzle schema.

-- Nash opps: Indira Foundation is the funder; household assignment was an
-- error during the bulk household pass. Clear household_id on these two.
UPDATE opportunities_and_pledges
   SET household_id = NULL
 WHERE id IN ('recdpCTCJZAxv8qIm', 'recSmHuyBYL310qux')
   AND household_id IS NOT NULL;

-- ============================================================================
-- 2026-05  Individual-giver → individual-advisor corrections
-- ============================================================================
-- Two opps had both funder_id and individual_giver_person_id set. The intent
-- in both cases was that the person *advises* a gift coming from the funder
-- (DAF-style or board-directed), not that the person is the donor.
--   recpKLV4T49USkAQ8: Dana Anderson directs as McKnight Foundation board member
--   recMIHrWz4wziYD9s: Margie Thorne advises via Thorne family fund DAF
UPDATE opportunities_and_pledges
   SET individual_advisor_person_id = individual_giver_person_id,
       individual_giver_person_id   = NULL
 WHERE id IN ('recpKLV4T49USkAQ8', 'recMIHrWz4wziYD9s')
   AND individual_giver_person_id IS NOT NULL;

-- ============================================================================
-- 2026-05  Funder/organization historical_names backfills
-- ============================================================================
UPDATE funders SET historical_names = ARRAY['Laura and John Arnold Foundation']
 WHERE id = 'rec3ToIYxYR0i6sgX'  -- Arnold Ventures
   AND NOT (historical_names @> ARRAY['Laura and John Arnold Foundation']);

UPDATE organizations SET historical_names = ARRAY['Facebook']
 WHERE name = 'Meta'
   AND NOT (COALESCE(historical_names,'{}') @> ARRAY['Facebook']);

UPDATE organizations
   SET historical_names = ARRAY['Impact for Education','Leveraged Impact']
 WHERE name = 'Building Impact Partners'
   AND NOT (COALESCE(historical_names,'{}')
              @> ARRAY['Impact for Education','Leveraged Impact']);

-- ============================================================================
-- 2026-05  Payment-intermediary type fix
-- ============================================================================
-- Bernstein is a private wealth manager, not a DAF or giving platform.
UPDATE payment_intermediaries
   SET type = 'private_wealth_manager'
 WHERE name ILIKE 'Bernstein%'
   AND type <> 'private_wealth_manager';

-- ============================================================================
-- 2026-05  Duplicate PER cleanup
-- ============================================================================
-- Cynthia Guill was double-inserted during the people_entity_roles recovery
-- pass (one real PER + one synth-per-* row). Drop the synth dup.
DELETE FROM people_entity_roles WHERE id = 'synth-per-013-cynthia-guill';

COMMIT;
