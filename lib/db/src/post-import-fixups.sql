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
-- 2026-05  Zero-donor gift/opp triage (12 rows, all resolved via Copper opps
--          export + user direction; enables strict donor_xor = 1)
-- ============================================================================
-- Create synthetic person for Nathan Azevedo ($50 gift 2020-04-12; appears in
-- Copper opps with no linked person record).
INSERT INTO people (id, first_name, last_name, full_name)
VALUES ('synth-person-nathan-azevedo', 'Nathan', 'Azevedo', 'Nathan Azevedo')
ON CONFLICT (id) DO NOTHING;

-- recWL2I8BGNuJ3Tpj  $100k  2019-10-14 — Copper "Anonymous Donor - Elderberry
--   Gift" via Southwest Community Foundation DAF, advised by Meyer Bodoff.
UPDATE gifts_and_payments
   SET individual_giver_person_id = 'recxdjr7Q1BtvB89l',  -- Anonymous Donor
       advisor_person_id          = 'recNOGL88IjlmNc5O',  -- Meyer Bodoff
       primary_contact_person_id  = 'recNOGL88IjlmNc5O'
 WHERE id = 'recWL2I8BGNuJ3Tpj'
   AND (individual_giver_person_id IS DISTINCT FROM 'recxdjr7Q1BtvB89l'
        OR advisor_person_id        IS DISTINCT FROM 'recNOGL88IjlmNc5O');

-- rec9wS6zIZrIsxIqI  $70k   2021-01-12 — Copper "Transformative Black-Led
--   Movement Fund" (BLMF lives at Borealis Philanthropy).
UPDATE gifts_and_payments
   SET funder_id                  = 'rec3RspE0Ns70ouVE',  -- Borealis Philanthropy
       individual_giver_person_id = NULL
 WHERE id = 'rec9wS6zIZrIsxIqI'
   AND funder_id IS DISTINCT FROM 'rec3RspE0Ns70ouVE';

-- rec6B0yqPIR47JbIa  $7k    2021-04-16 (fy21 grant tag) — Nash family fund.
UPDATE gifts_and_payments
   SET funder_id = 'recR28K8Twq5uV8Q0'  -- Indira Foundation
 WHERE id = 'rec6B0yqPIR47JbIa'
   AND funder_id IS DISTINCT FROM 'recR28K8Twq5uV8Q0';

-- rechYr7WQGtI8vpqU  $50    2020-04-12 — Copper "Nathan Azevedo" (exact date).
UPDATE gifts_and_payments
   SET individual_giver_person_id = 'synth-person-nathan-azevedo'
 WHERE id = 'rechYr7WQGtI8vpqU'
   AND individual_giver_person_id IS DISTINCT FROM 'synth-person-nathan-azevedo';

-- 5 Donorbox campaign gifts + 2 other small no-context gifts → Anonymous Donor
-- catch-all. Copper had multiple identical-amount candidates per date for the
-- Donorbox ones, so specific attribution is unrecoverable.
UPDATE gifts_and_payments
   SET individual_giver_person_id = 'recxdjr7Q1BtvB89l'  -- Anonymous Donor
 WHERE id IN (
   'recHjYSw2kLKdLUos','recDESZVLWQcN7yUJ',
   'recS5h9aXr4VcvYCJ','recOnrXi2JCpc6cux','recYHLtt4GT65pOQT',
   'recU7CNSsks7xIPTk','recTLppW88mNdQUTK'
 ) AND individual_giver_person_id IS NULL;

-- recFjazmLRFI5DUA9  $15k cold-lead opp — usage_notes reference March
--   Foundation (funder exists in DB).
UPDATE opportunities_and_pledges
   SET funder_id = 'recgZp7jPII4953K0'  -- March Foundation
 WHERE id = 'recFjazmLRFI5DUA9'
   AND funder_id IS NULL;

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

-- ============================================================================
-- 2026-05  Nash pledge-payment donor reconciliation
-- ============================================================================
-- Companion to the earlier Nash opps fix: pledge recSmHuyBYL310qux ("Avi Nash
-- Seed Challenge Grant") is funded by Indira Foundation (recR28K8Twq5uV8Q0),
-- but the $100k payment gift recn6Gg4K1G31LnH5 still carried household_id=Nash
-- from the household pass. Flip the gift to match the pledge.
UPDATE gifts_and_payments
   SET household_id = NULL,
       funder_id    = 'recR28K8Twq5uV8Q0'
 WHERE id = 'recn6Gg4K1G31LnH5'
   AND (household_id = 'rec673AHumJJiIPSy'
        OR funder_id IS DISTINCT FROM 'recR28K8Twq5uV8Q0');

-- ============================================================================
-- 2026-05  Merge duplicate funder "Building Impact Partners"
-- ============================================================================
-- Two BIP funder rows existed: synth-funder-building-impact-partners (carried
-- 3 PERs + historical_names) and the real Airtable id recqGVa2GN2SfHKoW (no
-- attachments, correct funding_entity_subtype). Move PERs + historical_names
-- onto the real id and drop the synth.
UPDATE funders
   SET historical_names = ARRAY['Impact for Education','Leveraged Impact']::text[]
 WHERE id = 'recqGVa2GN2SfHKoW'
   AND (historical_names IS NULL OR historical_names = '{}');

UPDATE people_entity_roles
   SET funder_id = 'recqGVa2GN2SfHKoW'
 WHERE funder_id = 'synth-funder-building-impact-partners';

DELETE FROM funders WHERE id = 'synth-funder-building-impact-partners';

-- ============================================================================
-- 2026-05  Merge duplicate organization "Minnesota Chamber of Commerce"
-- ============================================================================
-- Two identical org rows. Keep recRisXQ8CI4UYHBK (3 PERs, 2 addresses).
-- Re-point the 1 address attached to recPix5M7st5QS0fB, then delete it.
UPDATE addresses
   SET organization_id = 'recRisXQ8CI4UYHBK'
 WHERE organization_id = 'recPix5M7st5QS0fB';

DELETE FROM organizations WHERE id = 'recPix5M7st5QS0fB';

COMMIT;
