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

-- ============================================================================
-- 2026-05  Won-opp allocation drift fixes (Copper-export adjudication)
-- ============================================================================
-- Two won opps had pledge_allocations sub_amount totals diverging from
-- awarded_amount. Reconciled against the Copper opps export.

-- Wend FY21-23 (recNS30L7jeRdzHFb): PR FY22 alloc reccV4rFVmfSloY3D was $450k
-- but Copper Won PR FY22 = $200k + $200k = $400k. Reduce to $400k so the
-- region/FY breakdown matches actual receipts ($4.5M total).
UPDATE pledge_allocations
   SET sub_amount = 400000.00
 WHERE id = 'reccV4rFVmfSloY3D'
   AND sub_amount = 450000.00;

-- CityBridge "FY19 and FY20" (rec5RteGKx2FkTinx): FY19 alloc was missing the
-- 7/27/2018 "First D.C. payment" of $10k. Bump $60k → $70k. Also restore the
-- $0.14 cents on the FY20 row + awarded_amount so totals reconcile with
-- payments ($215,015.14).
UPDATE pledge_allocations
   SET sub_amount = 70000.00
 WHERE id = 'recEZOGCINYEvl65q'
   AND sub_amount = 60000.00;
UPDATE pledge_allocations
   SET sub_amount = 145015.14
 WHERE id = 'rechwpjAb3iaG9WIX'
   AND sub_amount = 145015.00;
UPDATE opportunities_and_pledges
   SET awarded_amount = 215015.14
 WHERE id = 'rec5RteGKx2FkTinx'
   AND awarded_amount = 215015.00;

COMMIT;

-- ============================================================================
-- 2026-05  Copper-recovered allocations for lost/dormant opps (R4)
-- ============================================================================
-- 181 of 188 DB lost+dormant opps lacking pledge_allocations were matched to
-- the Copper opps export (attached_assets/opportunities_*.xlsx) by
-- (funder, name) or (name) and the recoverable scope (grant_year,
-- hub_intended_use, hub_region, loss_reason) backfilled here. Synthesized
-- row IDs follow `synth-pa-copper-<oppId>` so re-runs are idempotent.
-- Per SCHEMA.md: lost -> status='abandoned', dormant -> status='working'.
-- The 7 unmatched DB opps + ambiguous-resolution notes are in RESEARCH_QUEUE.md (R4).
--
-- ALSO: 15 loss_reason values backfilled from Copper's `Loss Reason` column
-- (the 16th Copper-side loss_reason was on a row that matched a DB opp marked
-- 'dormant' rather than 'lost', so it was not applied).

BEGIN;

-- 181 pledge_allocations rows (88 lost/abandoned + dormant/working)

INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recAJrLyKH1WHC1qV', 'recAJrLyKH1WHC1qV', 100000.00, 'abandoned', 'wildflower_foundation', 'fy2018', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recOL3xl6QRS0MSkH', 'recOL3xl6QRS0MSkH', 20000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-reczdiRE8vQ046Okx', 'reczdiRE8vQ046Okx', 4000000.00, 'working', 'sunlight_debt', 'fy2023', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recmnUVImd3FrVovC', 'recmnUVImd3FrVovC', 1500000.00, 'abandoned', 'observation_support_tech', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recNCePHVNrOgoPJs', 'recNCePHVNrOgoPJs', 100000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__north_carolina']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recTTpRdpnkFuuNzT', 'recTTpRdpnkFuuNzT', 100000.00, 'abandoned', 'observation_support_tech', 'fy2023', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recvnBcR2jUxX87Mp', 'recvnBcR2jUxX87Mp', 50000.00, 'abandoned', 'wildflower_foundation', 'fy2021', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec8jkTO0UGC6LmiH', 'rec8jkTO0UGC6LmiH', 35000.00, 'abandoned', 'wildflower_foundation', 'fy2021', ARRAY['united_states__indiana']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recGx5lVjYglr2108', 'recGx5lVjYglr2108', 20000.00, 'abandoned', 'wildflower_foundation', 'fy2023', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recHQwayeGfn6zhcH', 'recHQwayeGfn6zhcH', NULL, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recu0ImIWLBFS5nGL', 'recu0ImIWLBFS5nGL', 25000.00, 'abandoned', 'wildflower_foundation', 'fy2023', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recevpvUzyD1K40Wt', 'recevpvUzyD1K40Wt', 250000.00, 'abandoned', 'wildflower_foundation', 'fy2018', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec0o4DwDfjHXwXoV', 'rec0o4DwDfjHXwXoV', 100000.00, 'working', 'wildflower_foundation', 'fy2020', ARRAY['united_states__colorado']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recFOCkaNaq22A5SD', 'recFOCkaNaq22A5SD', 250000.00, 'abandoned', 'wildflower_foundation', 'fy2021', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-reczNX8QKhmk0TPlG', 'reczNX8QKhmk0TPlG', 215000.00, 'abandoned', 'wildflower_foundation', 'fy2021', ARRAY['united_states__maryland__washington_d_c']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recWn3cQm78XrR75S', 'recWn3cQm78XrR75S', 250000.00, 'abandoned', 'wildflower_foundation', 'fy2018', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recIAHDfwS7qTTgHJ', 'recIAHDfwS7qTTgHJ', 150000.00, 'abandoned', 'wildflower_foundation', 'fy2022', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec8c5ZM8AMi7KQkW', 'rec8c5ZM8AMi7KQkW', 500000.00, 'abandoned', 'wildflower_foundation', 'fy2021', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recmtqwq4uJBLyrV3', 'recmtqwq4uJBLyrV3', 100000.00, 'abandoned', 'wildflower_foundation', 'fy2024', ARRAY['united_states__colorado']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec0YSAMAiQvZcFqW', 'rec0YSAMAiQvZcFqW', 200000.00, 'working', 'wildflower_foundation', 'fy2020', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recRBXlELrXSDI9Qx', 'recRBXlELrXSDI9Qx', 50000.00, 'abandoned', 'wildflower_foundation', 'fy2019', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recVAGfxuDcDIMp1n', 'recVAGfxuDcDIMp1n', 250000.00, 'abandoned', 'wildflower_foundation', 'fy2018', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec3UxY98sGUMuEZf', 'rec3UxY98sGUMuEZf', 250000.00, 'abandoned', 'wildflower_foundation', 'fy2020', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recHcH5ZKego9IMiR', 'recHcH5ZKego9IMiR', 175.00, 'working', 'wildflower_foundation', 'fy2020', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recZXQ7qD2rWS0PIV', 'recZXQ7qD2rWS0PIV', 200000.00, 'abandoned', 'wildflower_foundation', 'fy2019', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recTA5b7NzMLLNNNI', 'recTA5b7NzMLLNNNI', 1000000.00, 'working', 'wildflower_foundation', 'fy2022', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recEAvqfynXSobsxl', 'recEAvqfynXSobsxl', NULL, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recB249EGYcra517U', 'recB249EGYcra517U', 25000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recYGuHPPImYWrbjK', 'recYGuHPPImYWrbjK', 1000000.00, 'abandoned', 'wildflower_foundation', 'fy2019', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec32SEJI5fzlRm2L', 'rec32SEJI5fzlRm2L', 4000000.00, 'working', 'observation_support_tech', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recGc4GKX4c1MyPKT', 'recGc4GKX4c1MyPKT', NULL, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recvx9JDn4goMkgYB', 'recvx9JDn4goMkgYB', 200000.00, 'working', 'wildflower_foundation', 'fy2019', ARRAY['united_states__massachusetts']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec5WohSKXqqujxKz', 'rec5WohSKXqqujxKz', 10000.00, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec9QjNjZqvI0gQC2', 'rec9QjNjZqvI0gQC2', 500000.00, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__new_york_state']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recNs6E6yb6FWG5qP', 'recNs6E6yb6FWG5qP', 100000.00, 'abandoned', 'wildflower_foundation', 'fy2019', ARRAY['united_states__new_york_state']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recWrLPqkvMGcRm2K', 'recWrLPqkvMGcRm2K', NULL, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recC226K8Ub7jcgER', 'recC226K8Ub7jcgER', 50000.00, 'working', 'wildflower_foundation', 'fy2020', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recUTaRxS3yMJbZjj', 'recUTaRxS3yMJbZjj', 50000.00, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__indiana']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recnfUnTHjWiFzClW', 'recnfUnTHjWiFzClW', 250000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec9VusmYAJkEJa7y', 'rec9VusmYAJkEJa7y', 50.00, 'abandoned', 'wildflower_foundation', NULL, ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec1O8d9LDiZNOSTQ', 'rec1O8d9LDiZNOSTQ', 141000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__maryland__washington_d_c']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec1TeANeR2IZFdz5', 'rec1TeANeR2IZFdz5', 10000.00, 'abandoned', 'wildflower_foundation', 'fy2019', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recN2DjdCn17T9MV3', 'recN2DjdCn17T9MV3', 100000.00, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__new_york_state']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recsH6IPhCm0bxE9v', 'recsH6IPhCm0bxE9v', 100000.00, 'working', 'wildflower_foundation', 'fy2021', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recTjSEyOa9X4Y0Nx', 'recTjSEyOa9X4Y0Nx', 100000.00, 'abandoned', 'wildflower_foundation', 'fy2018', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec7DPKatqsiMR64p', 'rec7DPKatqsiMR64p', 100000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recSiNSURvJxkwRes', 'recSiNSURvJxkwRes', 100000.00, 'abandoned', 'wildflower_foundation', 'fy2021', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recqK3uuXuP8SeyrU', 'recqK3uuXuP8SeyrU', 50000.00, 'working', 'wildflower_foundation', 'fy2020', ARRAY['united_states__north_carolina']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recieMLuhaiO635nS', 'recieMLuhaiO635nS', 100000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recEwxzjO42tA7lBb', 'recEwxzjO42tA7lBb', 100000.00, 'abandoned', 'wildflower_foundation', 'fy2018', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recgJPfZrEiDHlKbF', 'recgJPfZrEiDHlKbF', 100.00, 'working', 'wildflower_foundation', 'fy2021', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recK9uFtltihgwXrz', 'recK9uFtltihgwXrz', 250000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recWy9QFGc8Er9gAR', 'recWy9QFGc8Er9gAR', 100000.00, 'working', 'wildflower_foundation', 'fy2021', ARRAY['united_states__mid_atlantic']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec6mz93SN9BSntsw', 'rec6mz93SN9BSntsw', 300000.00, 'abandoned', 'wildflower_foundation', 'fy2023', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recbCaNtrY7aRBtuZ', 'recbCaNtrY7aRBtuZ', 250000.00, 'working', 'wildflower_foundation', 'fy2020', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recZNlYp3505dtTms', 'recZNlYp3505dtTms', 35000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__maryland__washington_d_c']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recVonUbOJ9hiwbyZ', 'recVonUbOJ9hiwbyZ', 100000.00, 'working', 'wildflower_foundation', 'fy2020', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recuCztopBcwGhJCS', 'recuCztopBcwGhJCS', 150000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recqy0bL4JkesStnA', 'recqy0bL4JkesStnA', 50000.00, 'abandoned', 'wildflower_foundation', 'fy2018', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recSvLYN8KBFRT1Pe', 'recSvLYN8KBFRT1Pe', 100000.00, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec8erSyDXwNmkIPq', 'rec8erSyDXwNmkIPq', 700000.00, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__massachusetts']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec5htjLGQTRkkkeU', 'rec5htjLGQTRkkkeU', 100000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec7IiQAuPjdAMKtB', 'rec7IiQAuPjdAMKtB', 250000.00, 'abandoned', 'wildflower_foundation', 'fy2023', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recmxodfMXhxo1eq5', 'recmxodfMXhxo1eq5', 30000.00, 'abandoned', 'wildflower_foundation', 'fy2022', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recshi9Srdid53Ch8', 'recshi9Srdid53Ch8', 12500.00, 'working', 'wildflower_foundation', 'fy2023', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recVKGJb5rOkERke7', 'recVKGJb5rOkERke7', 250000.00, 'abandoned', 'wildflower_foundation', 'fy2023', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recYZ3qlDtZ0W9G6z', 'recYZ3qlDtZ0W9G6z', 35000.00, 'abandoned', 'wildflower_foundation', 'fy2021', ARRAY['united_states__indiana']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recGuBh0fBStVZ6i0', 'recGuBh0fBStVZ6i0', 150000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recsxJXOJexn8FLcO', 'recsxJXOJexn8FLcO', NULL, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec9xyJzWTEtEhwxR', 'rec9xyJzWTEtEhwxR', 100000.00, 'working', 'observation_support_tech', 'fy2023', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-reczkagcS7LoaCCfR', 'reczkagcS7LoaCCfR', 100000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec0WVLHTuQdglLdC', 'rec0WVLHTuQdglLdC', 25000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__puerto_rico']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-reca6AI5D32CmJWQU', 'reca6AI5D32CmJWQU', 25000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__maryland__washington_d_c']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recnjWoFMEeHiVQZG', 'recnjWoFMEeHiVQZG', 750000.00, 'working', 'wildflower_foundation', 'fy2025', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec7Lc8QioIggVXM8', 'rec7Lc8QioIggVXM8', 1000000.00, 'abandoned', 'wildflower_foundation', 'fy2024', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recyKWuSaD8rwDcT4', 'recyKWuSaD8rwDcT4', 1000000.00, 'abandoned', 'wildflower_foundation', 'fy2023', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recaGcNEGFHsEZNcE', 'recaGcNEGFHsEZNcE', 100000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recQrY25ixKA2qZgj', 'recQrY25ixKA2qZgj', 50000.00, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recxR3SY3SknPigQV', 'recxR3SY3SknPigQV', NULL, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recc4VhTg9NqOcSf3', 'recc4VhTg9NqOcSf3', 100000.00, 'abandoned', 'wildflower_foundation', 'fy2023', ARRAY['united_states__new_york_state']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recXHfy4lHRHYsYY0', 'recXHfy4lHRHYsYY0', 10000.00, 'abandoned', 'wildflower_foundation', 'fy2021', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec2YHolVH3pXiqIU', 'rec2YHolVH3pXiqIU', 35000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__indiana']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recjpejSs2ro6TGzy', 'recjpejSs2ro6TGzy', 4500000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recWxbSSsrc9zQatB', 'recWxbSSsrc9zQatB', 25000.00, 'working', 'wildflower_foundation', 'fy2023', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recn3SXUt8JGALx0c', 'recn3SXUt8JGALx0c', 500000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recLusy4A3P6euYNd', 'recLusy4A3P6euYNd', 75000.00, 'working', 'wildflower_foundation', 'fy2020', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recTrWZy4yxCsKm3a', 'recTrWZy4yxCsKm3a', 100000.00, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__massachusetts']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recXEdkwM3cp6ydV1', 'recXEdkwM3cp6ydV1', NULL, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec2q7AZ48MQKXsf4', 'rec2q7AZ48MQKXsf4', NULL, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recgBHDUZmz3zrNEK', 'recgBHDUZmz3zrNEK', NULL, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recVGG8jrAbqMrNPt', 'recVGG8jrAbqMrNPt', NULL, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recrT2gK7ubxmQEEe', 'recrT2gK7ubxmQEEe', 250000.00, 'working', 'wildflower_foundation', 'fy2020', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rectEO7MLTh4OJ61z', 'rectEO7MLTh4OJ61z', 15000.00, 'working', 'wildflower_foundation', 'fy2020', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recQGWrKFXcYHtaWb', 'recQGWrKFXcYHtaWb', 50000.00, 'working', 'wildflower_foundation', 'fy2020', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rectmiSROpwGpHlTX', 'rectmiSROpwGpHlTX', 25000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__maryland__washington_d_c']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recHtA9MEJiRmaLha', 'recHtA9MEJiRmaLha', 25000.00, 'abandoned', 'wildflower_foundation', 'fy2023', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec5ZG5o3UWivkL3L', 'rec5ZG5o3UWivkL3L', 100000.00, 'working', 'wildflower_foundation', 'fy2021', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recbMikoIQyPlZ0uR', 'recbMikoIQyPlZ0uR', 500000.00, 'working', 'wildflower_foundation', 'fy2020', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recr9dJ9nNYMTCSbU', 'recr9dJ9nNYMTCSbU', 250000.00, 'abandoned', 'wildflower_foundation', 'fy2021', ARRAY['united_states__new_york_state']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recYduhPYqwOWSB0R', 'recYduhPYqwOWSB0R', 100000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recMubCu8gm6ZIP6A', 'recMubCu8gm6ZIP6A', 50000.00, 'working', 'wildflower_foundation', 'fy2022', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rechZ2UjeDtjK3w4O', 'rechZ2UjeDtjK3w4O', 100000.00, 'abandoned', 'observation_support_tech', 'fy2024', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recaNZTQVMgpJVxkR', 'recaNZTQVMgpJVxkR', 150000.00, 'working', 'wildflower_foundation', 'fy2021', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec7Wwt50fydZordA', 'rec7Wwt50fydZordA', NULL, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recvxGJg110AdLN3J', 'recvxGJg110AdLN3J', 0.00, 'abandoned', 'wildflower_foundation', NULL, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recaFO52tbVDXqBYD', 'recaFO52tbVDXqBYD', 100000.00, 'working', 'wildflower_foundation', 'fy2019', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recHyILNtQRzhmSH5', 'recHyILNtQRzhmSH5', 100000.00, 'abandoned', 'wildflower_foundation', 'fy2019', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recsEzE03fwTTIwa5', 'recsEzE03fwTTIwa5', 2000000.00, 'working', 'observation_support_tech', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rect4F8b81oIk4m44', 'rect4F8b81oIk4m44', 600000.00, 'abandoned', 'wildflower_foundation', 'fy2024', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rechyDSuhbquEw8Xb', 'rechyDSuhbquEw8Xb', 50000.00, 'abandoned', 'wildflower_foundation', 'fy2025', ARRAY['united_states__mid_atlantic']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recZVRXISct2s1aCa', 'recZVRXISct2s1aCa', 100000.00, 'abandoned', 'wildflower_foundation', 'fy2017', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-reccYwWypV6ITMQse', 'reccYwWypV6ITMQse', NULL, 'working', 'wildflower_foundation', 'fy2019', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recwNZPDHkCSogmxD', 'recwNZPDHkCSogmxD', 30000.00, 'abandoned', 'wildflower_foundation', 'fy2019', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recaqBoSM8hBGALzj', 'recaqBoSM8hBGALzj', NULL, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recddQMwPcVRPGgKw', 'recddQMwPcVRPGgKw', NULL, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__massachusetts']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec2GwqQHOjW9FVJp', 'rec2GwqQHOjW9FVJp', 1000000.00, 'abandoned', 'wildflower_foundation', 'fy2022', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec6aSm8bYnzgL5kT', 'rec6aSm8bYnzgL5kT', NULL, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recj4D8XNG8m3kwMa', 'recj4D8XNG8m3kwMa', 100000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec5mTbhlvd3J99PX', 'rec5mTbhlvd3J99PX', 50000.00, 'abandoned', 'wildflower_foundation', 'fy2019', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recpKLV4T49USkAQ8', 'recpKLV4T49USkAQ8', 25000.00, 'abandoned', 'wildflower_foundation', 'fy2021', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recUz9Z7dUmqNHIpv', 'recUz9Z7dUmqNHIpv', NULL, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recPioSxn2y7wXrsW', 'recPioSxn2y7wXrsW', 500000.00, 'abandoned', 'sunlight_debt', 'fy2019', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recofM0CR0SRCf0SP', 'recofM0CR0SRCf0SP', 250000.00, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__massachusetts']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rectRWQusOhXqdmTQ', 'rectRWQusOhXqdmTQ', 2000000.00, 'working', 'wildflower_foundation', 'fy2019', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec8yyLqcliI8jTwa', 'rec8yyLqcliI8jTwa', 100000.00, 'abandoned', 'wildflower_foundation', 'fy2019', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-reciaOF37ouO66eqF', 'reciaOF37ouO66eqF', 20000.00, 'abandoned', 'wildflower_foundation', 'fy2023', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recZ4plX9bkDckmp2', 'recZ4plX9bkDckmp2', 20000.00, 'abandoned', 'wildflower_foundation', 'fy2022', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recRNLXIZMtP7aShI', 'recRNLXIZMtP7aShI', NULL, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__california']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recSz2d1JeiZioeTQ', 'recSz2d1JeiZioeTQ', 500000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recihmgAGhATl9oYn', 'recihmgAGhATl9oYn', 200000.00, 'abandoned', 'wildflower_foundation', 'fy2020', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recC3JkmkJgMRxuWQ', 'recC3JkmkJgMRxuWQ', 150000.00, 'abandoned', 'wildflower_foundation', 'fy2021', ARRAY['united_states__maryland__washington_d_c']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recFi0nBl6boKQAR1', 'recFi0nBl6boKQAR1', 50000.00, 'working', 'wildflower_foundation', 'fy2018', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec7QecSllesMzYPh', 'rec7QecSllesMzYPh', 500000.00, 'working', 'wildflower_foundation', 'fy2022', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec1xtFib60rXNWID', 'rec1xtFib60rXNWID', 100000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec0Jruqw1b16e1Lh', 'rec0Jruqw1b16e1Lh', 150000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__maryland__washington_d_c']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recpUoRl9SvmCxoAk', 'recpUoRl9SvmCxoAk', 206000.00, 'abandoned', 'wildflower_foundation', 'fy2025', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recgCGIXhCbHpEOvl', 'recgCGIXhCbHpEOvl', 25000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recWTtpkUCQRNpQVJ', 'recWTtpkUCQRNpQVJ', 250000.00, 'abandoned', 'wildflower_foundation', 'fy2020', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-reclGzNaNClPK5Vby', 'reclGzNaNClPK5Vby', 100000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recmH0LlzEjD6ME8v', 'recmH0LlzEjD6ME8v', 60000.00, 'abandoned', 'wildflower_foundation', 'fy2019', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recrKnfXKVscPBGMF', 'recrKnfXKVscPBGMF', 40000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__maryland__washington_d_c']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec01E7iA4JD5LKfj', 'rec01E7iA4JD5LKfj', 500000.00, 'working', 'wildflower_foundation', NULL, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recLVpsfzi9BlJv8V', 'recLVpsfzi9BlJv8V', 2000000.00, 'working', 'observation_support_tech', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recwm7iFH8aexTAUu', 'recwm7iFH8aexTAUu', 25000.00, 'abandoned', 'wildflower_foundation', 'fy2024', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recfCES9q23SnanDc', 'recfCES9q23SnanDc', 35000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__indiana']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recfh0YZ8e5Js1vv1', 'recfh0YZ8e5Js1vv1', 150000.00, 'abandoned', 'observation_support_tech', 'fy2023', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recncti6qgFZoRJ8R', 'recncti6qgFZoRJ8R', 1000000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rectHemay0VaaUCbv', 'rectHemay0VaaUCbv', 25000.00, 'working', 'wildflower_foundation', 'fy2023', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec22UU69qyCo2ZIu', 'rec22UU69qyCo2ZIu', 50000.00, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recF7ICi8lQFxibPL', 'recF7ICi8lQFxibPL', 2000000.00, 'abandoned', 'sunlight_debt', 'fy2023', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec5U33MfyglBoEma', 'rec5U33MfyglBoEma', 500000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recbYxTAUssWy1e5g', 'recbYxTAUssWy1e5g', 35000.00, 'abandoned', 'wildflower_foundation', 'fy2021', ARRAY['united_states__maryland__washington_d_c']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recNo7p6SVzquLIme', 'recNo7p6SVzquLIme', 250000.00, 'abandoned', 'wildflower_foundation', 'fy2018', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recxrSUP9p98LNnN4', 'recxrSUP9p98LNnN4', NULL, 'working', 'wildflower_foundation', 'fy2024', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recO8OnfkGksP1be4', 'recO8OnfkGksP1be4', 250000.00, 'abandoned', 'observation_support_tech', 'fy2024', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recyswnVx9hcJCsHU', 'recyswnVx9hcJCsHU', 250000.00, 'abandoned', 'wildflower_foundation', 'fy2018', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recRU2pSmJ5QSPA1s', 'recRU2pSmJ5QSPA1s', 25000.00, 'working', 'wildflower_foundation', 'fy2020', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec0bGTHdSjmssvK6', 'rec0bGTHdSjmssvK6', 1000000.00, 'abandoned', 'observation_support_tech', 'fy2024', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recuYcV9vMXL3piij', 'recuYcV9vMXL3piij', 500000.00, 'abandoned', 'wildflower_foundation', 'fy2024', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recdpz54EhIsDaOiS', 'recdpz54EhIsDaOiS', 500000.00, 'working', 'wildflower_foundation', 'fy2019', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rectig1Rlp05q38Mn', 'rectig1Rlp05q38Mn', 150000.00, 'working', 'wildflower_foundation', 'fy2022', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-reccRbzp9Fx7ytoRq', 'reccRbzp9Fx7ytoRq', 100000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recBkglVJAkQuHQ7t', 'recBkglVJAkQuHQ7t', NULL, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recIiVZPx1NT8qY84', 'recIiVZPx1NT8qY84', 100000.00, 'working', 'wildflower_foundation', 'fy2020', ARRAY['united_states__massachusetts']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recoEvb0plyhR2Wtv', 'recoEvb0plyhR2Wtv', 500000.00, 'working', 'observation_support_tech', 'fy2024', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recsTMS8osZXHW6qR', 'recsTMS8osZXHW6qR', 250000.00, 'abandoned', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recaREyxE0vWHVdu4', 'recaREyxE0vWHVdu4', 500000.00, 'working', 'wildflower_foundation', 'fy2020', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recB9hMY7vp7FEqlv', 'recB9hMY7vp7FEqlv', 50000.00, 'abandoned', 'wildflower_foundation', 'fy2018', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recmXgR0i6wPMdyWZ', 'recmXgR0i6wPMdyWZ', 50000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recTn2RJgppIsjgDv', 'recTn2RJgppIsjgDv', 100000.00, 'abandoned', 'wildflower_foundation', 'fy2024', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recP2ndRAx56qmx9I', 'recP2ndRAx56qmx9I', 125000.00, 'abandoned', 'wildflower_foundation', 'fy2018', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recx2pj8EAY25kHNY', 'recx2pj8EAY25kHNY', 74000.00, 'working', 'wildflower_foundation', 'fy2024', ARRAY['united_states__colorado']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-rec4NGtUWc4dTEiVe', 'rec4NGtUWc4dTEiVe', 25000.00, 'working', 'wildflower_foundation', 'future', ARRAY['united_states__minnesota']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recmlvpH2xaUJAaLl', 'recmlvpH2xaUJAaLl', 1000000.00, 'working', 'sunlight_debt', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recMgGUSiIcuRy9vb', 'recMgGUSiIcuRy9vb', 100000.00, 'working', 'wildflower_foundation', 'fy2022', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recRhhJtQg2Fgv23A', 'recRhhJtQg2Fgv23A', NULL, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recL0sDoKuQqNTLiI', 'recL0sDoKuQqNTLiI', 500000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recuxQJq3eu7WDaMS', 'recuxQJq3eu7WDaMS', 100000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__maryland__washington_d_c']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recRqOfHAHccZumFx', 'recRqOfHAHccZumFx', 100000.00, 'working', 'wildflower_foundation', 'future', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recp7ETyB8pgroPYe', 'recp7ETyB8pgroPYe', NULL, 'working', 'wildflower_foundation', 'fy2019', ARRAY['united_states__colorado']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO pledge_allocations (id, pledge_or_opportunity_id, sub_amount, status, entity_id, grant_year, region_ids) VALUES ('synth-pa-copper-recUrOtj5xkqtqAWq', 'recUrOtj5xkqtqAWq', 35000.00, 'abandoned', 'wildflower_foundation', 'fy2020', ARRAY['united_states__massachusetts']::text[]) ON CONFLICT (id) DO NOTHING;

-- 15 loss_reason backfills

UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='recIAHDfwS7qTTgHJ' AND loss_reason IS NULL;
UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='rec9VusmYAJkEJa7y' AND loss_reason IS NULL;
UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='recuCztopBcwGhJCS' AND loss_reason IS NULL;
UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='recqy0bL4JkesStnA' AND loss_reason IS NULL;
UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='rec7Lc8QioIggVXM8' AND loss_reason IS NULL;
UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='recr9dJ9nNYMTCSbU' AND loss_reason IS NULL;
UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='recvxGJg110AdLN3J' AND loss_reason IS NULL;
UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='rechyDSuhbquEw8Xb' AND loss_reason IS NULL;
UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='rec2GwqQHOjW9FVJp' AND loss_reason IS NULL;
UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='recPioSxn2y7wXrsW' AND loss_reason IS NULL;
UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='recC3JkmkJgMRxuWQ' AND loss_reason IS NULL;
UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='recWTtpkUCQRNpQVJ' AND loss_reason IS NULL;
UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='recF7ICi8lQFxibPL' AND loss_reason IS NULL;
UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='recuYcV9vMXL3piij' AND loss_reason IS NULL;
UPDATE opportunities_and_pledges SET loss_reason='Strategy Fit' WHERE id='recP2ndRAx56qmx9I' AND loss_reason IS NULL;

COMMIT;
