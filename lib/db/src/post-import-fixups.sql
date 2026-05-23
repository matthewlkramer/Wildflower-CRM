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

-- ============================================================================
-- 2026-05  Primary-contact backfill (R5)
-- ============================================================================
-- Phase 1 (applied directly to dev DB, replayed here for fresh imports):
--   Auto-set primary_contact=true on the sole current PER for every entity
--   that had exactly 1 current PER and none flagged primary. Covered all 4
--   entity types: 72 funders + 524 orgs + 38 households + 3 payment
--   intermediaries = 637 entities fixed.

BEGIN;

-- Phase 1 replay (idempotent): same logic as the ad-hoc UPDATE
WITH entity_per_counts AS (
  SELECT entity_type,
         COALESCE(funder_id,organization_id,household_id,payment_intermediary_id) AS eid,
         count(*) AS n_cur,
         bool_or(primary_contact) AS any_primary
  FROM people_entity_roles WHERE current='current'
  GROUP BY 1,2
),
fixable AS (
  SELECT entity_type, eid FROM entity_per_counts WHERE n_cur=1 AND NOT any_primary
)
UPDATE people_entity_roles per
   SET primary_contact = true, updated_at = now()
  FROM fixable f
 WHERE per.entity_type = f.entity_type
   AND COALESCE(per.funder_id,per.organization_id,per.household_id,per.payment_intermediary_id) = f.eid
   AND per.current = 'current'
   AND per.primary_contact = false;

-- Phase 2: 147 multi-PER cases disambiguated from Copper's `Primary Contact`
-- column in attached_assets/companies_*.xlsx (18 funders + 129 orgs).
-- These UPDATEs flip primary=true on the named PER and explicitly clear other
-- primary flags within the same entity (defensive — Phase 1 doesn't set any).

-- [funder] First Children''s Finance -> Suzanne Pearl (copper PC: Suzanne Pearl)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recPLjP4gwqyAHRNZ' AND primary_contact=false;
-- [funder] Emerson Collective -> Russlynn Ali (copper PC: Russlynn Ali)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recwpReRuz90O93Fr' AND primary_contact=false;
-- [funder] Puerto Rico Department of Education -> Julia Keleher (copper PC: Julia Keleher)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec8qzJ5nW7JD3wwl' AND primary_contact=false;
-- [funder] Calvert Impact Capital -> Catherine Godschalk (copper PC: Catherine Godschalk)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recvpofrc75SDuFJB' AND primary_contact=false;
-- [funder] City of Haverhill -> James Fiorentini (copper PC: James Fiorentini)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recTKXGeFrJ7QNPGb' AND primary_contact=false;
-- [funder] Acelero Learning -> Henry Wilde (copper PC: Henry Wilde)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='synth-per-058-henry-wilde' AND primary_contact=false;
-- [funder] Tyton Partners -> Adam Newman (copper PC: Adam Newman)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='synth-per-014-adam-newman' AND primary_contact=false;
-- [funder] Snap Inc -> Brandon Levin (copper PC: Brandon Levin)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='synth-per-034-brandon-levin' AND primary_contact=false;
-- [funder] City and County of Denver -> Clark Jolon (copper PC: Clark Jolon)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recZpdGTt9fpSvMBq' AND primary_contact=false;
-- [funder] New York State Education Department -> David Frank (copper PC: David Frank)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='synth-per-049-david-frank' AND primary_contact=false;
-- [funder] Equitable Facilities Fund -> Jon Rybka (copper PC: Jon Rybka)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recNydQKXrmjYugWn' AND primary_contact=false;
-- [funder] Thrive Services -> Darla Baquedano (copper PC: Darla Baquedano)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='synth-per-048-darla-baquedano' AND primary_contact=false;
-- [funder] Charter School Capital, Inc. -> Stuart Ellis (copper PC: Stuart Ellis)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='reco2pTiazSXxH8Ob' AND primary_contact=false;
-- [funder] New York City Economic Development Corporation -> Liat Krawczyk (copper PC: Liat Krawczyk)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recJReqZw7QOdgaL3' AND primary_contact=false;
-- [funder] City of Providence -> Theresa Agonia (copper PC: Theresa Agonia)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recfe2XTLymrnJu9V' AND primary_contact=false;
-- [funder] Mission Driven Finance -> Laura Kohn (copper PC: Laura Kohn)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recderAuXFrSvLoTV' AND primary_contact=false;
-- [funder] City Of Cambridge -> Marc McGovern (copper PC: Marc McGovern)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recnVcKKXIDspwGqS' AND primary_contact=false;
-- [funder] Colorado Charter School Institute -> Terry Croy Lewis (copper PC: Terry Croy Lewis)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='synth-per-110-terry-lewis' AND primary_contact=false;
-- [org] Chestnut Hill College -> Marj Horton (copper PC: Marj Horton)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recroLtrQCheXOBCz' AND primary_contact=false;
-- [org] Latinos for Education -> Amanda Fernandez (copper PC: Amanda Fernandez)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='reciSKtmDLr4fIH3C' AND primary_contact=false;
-- [org] Great Work Inc -> Robin Miller (copper PC: Robin Miller)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recvUoTKKTGc24cPx' AND primary_contact=false;
-- [org] East End House Inc -> Christine Christine (copper PC: Christine)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recYfEAi0HyFLoVZX' AND primary_contact=false;
-- [org] SEMGeeks -> Pete Schauer (copper PC: Pete Schauer)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recXd3wVVsLqWUxyy' AND primary_contact=false;
-- [org] University Of St. Thomas -> Emily Wingfield (copper PC: Emily Wingfield)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recI5fVFHjVscBca4' AND primary_contact=false;
-- [org] Intuit -> Scott Cook (copper PC: Scott Cook)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recf5yIEHLF5uzfMb' AND primary_contact=false;
-- [org] Aidan Montessori School -> Grace Lee (copper PC: Grace Lee)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recJbXTUaQUEBXpKM' AND primary_contact=false;
-- [org] Yes, Every Kid -> Heidie Nesset (copper PC: Heidie Nesset)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec7Fx4qhlym3InN1' AND primary_contact=false;
-- [org] Wôpanâak Language Reclamation Project -> Jennifer Weston (copper PC: Jennifer Weston)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recxZjQudz8FoVgcv' AND primary_contact=false;
-- [org] Falmouth Public Schools -> Thomas Bushy (copper PC: Thomas Bushy)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec60gKe7RG8TXSHg' AND primary_contact=false;
-- [org] The Caedmon School -> Matthew Stuart (copper PC: Matthew Stuart)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recg4GWZgB76eqdPP' AND primary_contact=false;
-- [org] Pillsbury Winthrop Shaw Pittman LLP -> Toni Rembe (copper PC: Toni Rembe)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec7qucyy0enHopmm' AND primary_contact=false;
-- [org] New York City Department of Education -> Kerri Nagorski (copper PC: Kerri Nagorski)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recLxXCH3NWeVgb0n' AND primary_contact=false;
-- [org] TNTP -> Tara Eckberg (copper PC: Tara Eckberg)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recQQw6pcbTryZzKG' AND primary_contact=false;
-- [org] CommonBond Communities company -> Jessie Hendel (copper PC: Jessie Hendel)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recPkYnGSUehr55FL' AND primary_contact=false;
-- [org] Education Evolving -> Alex Vitrella (copper PC: Alex Vitrella)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recVCAVDn8gGEUOmz' AND primary_contact=false;
-- [org] Bank Street College Of Education -> Regina Wright (copper PC: Regina Wright)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec4ggMjfCLW1ZdZb' AND primary_contact=false;
-- [org] Federal Reserve Bank of Minneapolis -> Art Rolnick (copper PC: Art Rolnick)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recdZXoWJB5tHvifh' AND primary_contact=false;
-- [org] Office of U.S. Senator Elizabeth Warren (D-MA) -> Caroline Ackerman (copper PC: Caroline Ackerman)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recH93zUo4UvWmgx0' AND primary_contact=false;
-- [org] Strategies for Children/ Early Education for all Campaign -> Amy O''Leary (copper PC: Amy O''Leary)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recpn38US5q6WK3ec' AND primary_contact=false;
-- [org] Indianapolis Public Schools -> Aleesia Johnson (copper PC: Aleesia Johnson)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recpar0EtuABMOdl6' AND primary_contact=false;
-- [org] The Anton Group - TAG -> Andrew Minck (copper PC: Andrew Minck)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recQF38nYHqogY2Ws' AND primary_contact=false;
-- [org] National Coalition Of Diverse Charter Schools -> Elsa Duré (copper PC: Elsa Duré)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec05FPDWBiyacwoo' AND primary_contact=false;
-- [org] Ed Visions -> Lisa Snyder (copper PC: Lisa Snyder)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='reco9CqqoTE3dM9bT' AND primary_contact=false;
-- [org] Immeasurable -> Blaine Vess (copper PC: Blaine Vess)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recfdwkxcTjPFXXjH' AND primary_contact=false;
-- [org] Educators 4 Excellence -> Evan Stone (copper PC: Evan Stone)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recUUoneYnhrVFliS' AND primary_contact=false;
-- [org] West Side Montessori School -> Lisanne Pinciotti (copper PC: Lisanne Pinciotti)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recMLS8n34XuCHNob' AND primary_contact=false;
-- [org] Harvard Business School -> David A. Moss (copper PC: David A. Moss)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recn3ywY9DTN5165j' AND primary_contact=false;
-- [org] Konscious -> Rodney Salomon (copper PC: Rodney Salomon)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recgw54WyCcsYQsvQ' AND primary_contact=false;
-- [org] U.S. Chamber of Commerce -> Brittany Scott (copper PC: Brittany Scott)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recMDvFK8PnGjdMVR' AND primary_contact=false;
-- [org] Association to Benefit Children -> Alaina Luisi (copper PC: Alaina Luisi)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recaIg1gqQ5vTiYrO' AND primary_contact=false;
-- [org] National Microschooling Center -> Don Soifer (copper PC: Don Soifer)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec0vfdvNLA0tmYLN' AND primary_contact=false;
-- [org] Massachusetts Public Charter School Association -> Beth Anderson (copper PC: Beth Anderson)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recNZrk4WFoGYdYbA' AND primary_contact=false;
-- [org] Community Action Inc -> Chris Espinola (copper PC: Chris Espinola)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recjPg8pLft4Stxye' AND primary_contact=false;
-- [org] Minnesota Business Partnership -> Jim Bartholomew (copper PC: Jim Bartholomew)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec8Dwt4ROcz42Ts9' AND primary_contact=false;
-- [org] Office of U.S. Representative Katherine Clark (D-MA) -> Wooyoung Lim (copper PC: Wooyoung Lim)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='reckYmRKluJQln7KC' AND primary_contact=false;
-- [org] New Horizons -> Dawn Mikkelson (copper PC: Dawn Mikkelson)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recGRKHURuUnJBb1J' AND primary_contact=false;
-- [org] Office of U.S. Senator Michael Bennet (D-CO) -> Michael Bennet (copper PC: Michael Bennet)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec3GYafCXOGs6cKr' AND primary_contact=false;
-- [org] Association Montessori International USA -> Denise Wanits (copper PC: Denise Wanits)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recbheXUUAVK1guv5' AND primary_contact=false;
-- [org] Office of Senator Tina Smith (D-MN) -> Jake Schwitzer (copper PC: Jake Schwitzer)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recOEHenPvKs0psOV' AND primary_contact=false;
-- [org] Leadership for Educational Equity -> Michael Buman (copper PC: Michael Buman)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recDJNFfumW98iYcE' AND primary_contact=false;
-- [org] EdSurge -> Betsy Corcoran (copper PC: Betsy Corcoran)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec09K1oahEhNlVjV' AND primary_contact=false;
-- [org] New Classrooms -> Joel Rose (copper PC: Joel Rose)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recULrMxgsl4meGxJ' AND primary_contact=false;
-- [org] The New York Times -> Dana Goldstein (copper PC: Dana Goldstein)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recbAcPhy5a2dMUAb' AND primary_contact=false;
-- [org] National Alliance for Public Charter Schools -> Ronald C. Rice (copper PC: Ronald C. Rice)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recqOvTsmXjpVKbSj' AND primary_contact=false;
-- [org] Office of U.S. Senator Amy Klobuchar (D-MN) -> April Jones (copper PC: April Jones)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recUNElFI1iOMPSlT' AND primary_contact=false;
-- [org] Higher Ground Education -> Sarah Lee (copper PC: Sarah Lee)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recpRyP6j6uSdKByd' AND primary_contact=false;
-- [org] Reach Capital -> Wayee Chu (copper PC: Wayee Chu)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recPGMhP9TqGmlewh' AND primary_contact=false;
-- [org] Taft -> Michael Gordon (copper PC: Michael Gordon)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec3Oqpcsmojsq6Dq' AND primary_contact=false;
-- [org] Allen & Company -> Nancy Peretsman (copper PC: Nancy Peretsman)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='reclGKvgAe8ZvAqNq' AND primary_contact=false;
-- [org] EPIC Colorado (Executives Partnering to Invest in Children) -> Marianne Hodge (copper PC: Marianne Hodge)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recml4UjLYK3bjZd4' AND primary_contact=false;
-- [org] Minnesota Chamber of Commerce -> Lauryn Schothorst (copper PC: Lauryn Schothorst)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recmjuft8dj07VVvi' AND primary_contact=false;
-- [org] St. Catherine University -> Syneva Barrett (copper PC: Syneva Barrett)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec7wQCXgEKuIqtXz' AND primary_contact=false;
-- [org] Education Reimagined -> Kelly Young (copper PC: Kelly Young)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rectut7EEUUxXgpUY' AND primary_contact=false;
-- [org] Two Sigma -> Lauren Penza (copper PC: Lauren Penza)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recHgJd7bmREqfQ31' AND primary_contact=false;
-- [org] Achievement First -> Ken Paul (copper PC: Ken Paul)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recARvb0WitFT6lKy' AND primary_contact=false;
-- [org] NYC Autism Charter School -> Christina Secharan (copper PC: Christina Secharan)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec60LZZJlYjy1yRf' AND primary_contact=false;
-- [org] The Washington Post -> Jay Mathews (copper PC: Jay Mathews)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='reclBxfLW3vixIqWS' AND primary_contact=false;
-- [org] Stepmojo -> Miho S. Kubagawa (copper PC: Miho S. Kubagawa)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recwY78D82cVL1dnM' AND primary_contact=false;
-- [org] Ready Nation / Council for a Strong America -> Barry Ford (copper PC: Barry Ford)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recCaJuWoyl2lpUr3' AND primary_contact=false;
-- [org] Pontifical Catholic University of Puerto Rico -> Jose M. Pizarro-Zayas (copper PC: Jose M. Pizarro-Zayas)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recE0BwbQ9XG8R43K' AND primary_contact=false;
-- [org] GrayHall LLP -> Karen Gray (copper PC: Karen Gray)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recgOqCLg2qihnrwy' AND primary_contact=false;
-- [org] DREAM Charter School -> Eve Colavito (copper PC: Eve Colavito)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recm42P2bYdaPn4p1' AND primary_contact=false;
-- [org] Gladwyne Montessori School -> Carrie Kries (copper PC: Carrie Kries)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recW7gAqcTGH0C1DH' AND primary_contact=false;
-- [org] California Charter Schools Association -> Judy Wilson (copper PC: Judy Wilson)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recLmCRC7hE2NKywL' AND primary_contact=false;
-- [org] Salem Public Schools -> Dr. Margaret Marotta (copper PC: Dr. Margaret Marotta)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recrvPqgDxZab0ZUD' AND primary_contact=false;
-- [org] Artistry and Scholarship -> Jill Davidson (copper PC: Jill Davidson)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recTCLJueUXqY5zYj' AND primary_contact=false;
-- [org] Democrats for Education Reform -> Jorge Elorza (copper PC: Jorge Elorza)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recOqBdFQ4vDV7Icf' AND primary_contact=false;
-- [org] Bellwether Education Partners -> Bonnie O''Keefe (copper PC: Bonnie O''Keefe)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recteaLYW7BSyi33U' AND primary_contact=false;
-- [org] Pioneer Press -> Mike Burbach (copper PC: Mike Burbach)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec17Le5sqYSgwaS9' AND primary_contact=false;
-- [org] A-Street Ventures -> Marc S. Sternberg (copper PC: Marc S. Sternberg)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recMoguhcyz49uhxu' AND primary_contact=false;
-- [org] Empower Schools -> Chris Gabrieli (copper PC: Chris Gabrieli)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='reckDBky8o0CJqOhk' AND primary_contact=false;
-- [org] Boston Public Schools -> Glenda L. Colón (copper PC: Glenda L. Colón)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recCJU0rp4px7wmzP' AND primary_contact=false;
-- [org] Union Beach School District -> Chantal Molino (copper PC: Chantal Molino)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec655CZPJbkCl1aK' AND primary_contact=false;
-- [org] New York City Charter School Center -> Myrah Murrell (copper PC: Myrah Murrell)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recMQaWXiqZDWkOGf' AND primary_contact=false;
-- [org] Minneapolis Public Schools -> Daniel Glass (copper PC: Daniel Glass)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recLtWGkvLGQNNWBF' AND primary_contact=false;
-- [org] WorldSavvy -> Dana Mortenson (copper PC: Dana Mortenson)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec8pSdit5s7fF7WI' AND primary_contact=false;
-- [org] AvalonBay Communities, Inc. -> Karen Hollinger (copper PC: Karen Hollinger)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recYXyRJV6olX9i2P' AND primary_contact=false;
-- [org] Bipartisan Policy Center -> Linda Smith (copper PC: Linda Smith)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec2wH8QGtbmrJyuG' AND primary_contact=false;
-- [org] Propel America -> Katharine Gallogly (copper PC: Katharine Gallogly)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recjgTblb5bYBTxwd' AND primary_contact=false;
-- [org] Social Innovation Forum -> Alex Frank (copper PC: Alex Frank)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='reclvvL8LOwuoGsuL' AND primary_contact=false;
-- [org] Metropolitan Montessori School -> Claudia Hamilton (copper PC: Claudia Hamilton)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec6oqOD3DzYYlZBd' AND primary_contact=false;
-- [org] Associated Builders and Contractors, Inc -> Kristen Swearingen (copper PC: Kristen Swearingen)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recwX79pyoCOBdVqS' AND primary_contact=false;
-- [org] Teach For All -> Wendy Kopp (copper PC: Wendy Kopp)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recrvYBxfwVgQ4UEQ' AND primary_contact=false;
-- [org] Winthrop & Weinstine. P.A. -> Jon L. Peterson (copper PC: Jon L. Peterson)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec29HFZ0VXNyI0Ch' AND primary_contact=false;
-- [org] 2Revolutions -> Todd Kern (copper PC: Todd Kern)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='reco5voLeIyTXoyeW' AND primary_contact=false;
-- [org] Learning Tapestry, Inc. -> Steve Midgley (copper PC: Steve Midgley)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='reccayhlR58YKoCUi' AND primary_contact=false;
-- [org] Moonshot edVentures -> Christine DeLeon (copper PC: Christine DeLeon)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recHVRjkEYZQaOYA7' AND primary_contact=false;
-- [org] Navitas Capital -> Louis Schotsky (copper PC: Louis Schotsky)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recITyUHu626Av3aP' AND primary_contact=false;
-- [org] Students for Education Reform -> Kenneth Eban (copper PC: Kenneth Eban)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='reczYe76t396djLLf' AND primary_contact=false;
-- [org] Thunder Valley Community Development Corporation -> Dallas Nelson (copper PC: Dallas Nelson)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recqIMgBOnE9uEHh9' AND primary_contact=false;
-- [org] Montessori Public Policy Initiative -> Wendy Shenk-Evans (copper PC: Wendy Shenk-Evans)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec2WuNSSJGBoX4kx' AND primary_contact=false;
-- [org] Cornerstone Montessori / Montessori Training Center of MN -> Liesl Taylor (copper PC: Liesl Taylor)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recz88NJAGMZ3SVI2' AND primary_contact=false;
-- [org] Minneapolis City Council -> Andrea Jenkins (copper PC: Andrea Jenkins)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recLIQ5sFAAMHTsJh' AND primary_contact=false;
-- [org] State University Of New York -> Maureen Foley (copper PC: Maureen Foley)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recRxruTCVJkPqJs3' AND primary_contact=false;
-- [org] Goldenrod Montessori -> Jill Evans (copper PC: Jill Evans)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recvKHDZRAogfDwRd' AND primary_contact=false;
-- [org] America Forward -> Roger Low (copper PC: Roger Low)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='reciceOeN44lDR7Mx' AND primary_contact=false;
-- [org] Arcon Partners -> Peter Flaherty (copper PC: Peter Flaherty)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recjjMqDPc72RJLR1' AND primary_contact=false;
-- [org] WeGrow -> Ben Shuldiner (copper PC: Ben Shuldiner)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recMO27goVZVu18fA' AND primary_contact=false;
-- [org] Center for Collaborative Education -> Dan French (copper PC: Dan French)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recubqVZlkd5M67w2' AND primary_contact=false;
-- [org] Color Genomics -> Elad Gil (copper PC: Elad Gil)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recBUVcAEOIQpMs9h' AND primary_contact=false;
-- [org] vChief - Virtual Chief of Staff Service -> Madeleine Niebauer (copper PC: Madeleine Niebauer)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec9ZAbzY63uMcLGM' AND primary_contact=false;
-- [org] AppleTree Institute for Education Innovation -> Isabella Sperduto (copper PC: Isabella Sperduto)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recu961QrYedsnXY3' AND primary_contact=false;
-- [org] Cambridge Public Schools -> Angeline UyHam (copper PC: Angeline UyHam)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec8pKQLcTcTmcY02' AND primary_contact=false;
-- [org] American Enterprise Institute -> Caitlyn Aversman (copper PC: Caitlyn Aversman)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec0vQwtINrOwzKQK' AND primary_contact=false;
-- [org] Haverhill Public Schools -> Jared Fulgoni (copper PC: Jared Fulgoni)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec9irSITmKShy0O9' AND primary_contact=false;
-- [org] Coughlan Companies / Capstone -> Maerin Coughlan (copper PC: Maerin Coughlan)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recCBTLVP3Oj7m4jJ' AND primary_contact=false;
-- [org] Penn Hill Group -> Danica Petroshius (copper PC: Danica Petroshius)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recboIvYLC2UcPUQE' AND primary_contact=false;
-- [org] 50CAN: the 50-State Campaign for Achievement Now -> Rebecca Greenberg-Ellis (copper PC: Rebecca Greenberg-Ellis)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recIlyXjEDLfmariI' AND primary_contact=false;
-- [org] Bloomberg Beta -> Roy Bahat (copper PC: Roy Bahat)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recdaJL2Uffb0U86T' AND primary_contact=false;
-- [org] Teaching Lab -> Sarah Johnson (copper PC: Sarah Johnson)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recflQQWor4xe8pnJ' AND primary_contact=false;
-- [org] KaBOOM -> E Alvarado (copper PC: Ealvarado)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='reccIA4p1j6xQiErC' AND primary_contact=false;
-- [org] Children''s Aid Society -> Phoebe Boyer (copper PC: Phoebe Boyer)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recE9SQpIHpH2m7Qz' AND primary_contact=false;
-- [org] Oak Rose Group -> Jason Gaulden (copper PC: Jason Gaulden)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recCwizL47v1DdtRs' AND primary_contact=false;
-- [org] ANet -> Melea Nalli (copper PC: Melea Nalli)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recKeKcoSlHDhFFmz' AND primary_contact=false;
-- [org] Wonder -> Zach Lahn (copper PC: Zach Lahn)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='receboGAVld6Sl434' AND primary_contact=false;
-- [org] Massachusetts Institute Of Technology (MIT) -> Sanjay Sarma (copper PC: Sanjay Sarma)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recf7Rkr40Xw2yMRF' AND primary_contact=false;
-- [org] Revolution School -> Henry D. Fairfax (copper PC: Henry D. D. Fairfax)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='reccua6fm6p3r7cjB' AND primary_contact=false;
-- [org] National Association of Manufacturers -> Christopher Netram (copper PC: Christopher Netram)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='rec2tU8eViMeegL3f' AND primary_contact=false;
-- [org] GSV Acceleration -> Michelle Fikany (copper PC: Michelle Fikany)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recZXaZjsf31aQzY6' AND primary_contact=false;
-- [org] Horizons for Homeless Children -> Kate Barrand (copper PC: Kate Barrand)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recQxspMIjbLHEg69' AND primary_contact=false;
-- [org] Harvard Graduate School Of Education -> Paul Reville (copper PC: Paul Reville)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recq4htyeYfFxVCPt' AND primary_contact=false;
-- [org] X -> Emi Kolawole (copper PC: Emi Kolawole)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recZwsKpvuq87GEFb' AND primary_contact=false;
-- [org] Brooklyn Heights Montessori School -> Martha Haakmat (copper PC: Martha Haakmat)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recmk12zkzH0YCim7' AND primary_contact=false;
-- [org] KinderCare Learning Centers , Inc. -> Marquita Davis (copper PC: Marquita Davis)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recNFLZVxfrqrOKnO' AND primary_contact=false;
-- [org] Denver Public Schools -> Christopher DeWitt (copper PC: Christopher DeWitt)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recXzYCWyRzO66wJD' AND primary_contact=false;
-- [org] New School of San Francisco -> Elizabeth Maki (copper PC: Elizabeth Maki)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recxjYEtdMs8DCtWZ' AND primary_contact=false;
-- [org] Education First -> Ila Deshmukh Towery (copper PC: Ila Deshmukh Towery)
UPDATE people_entity_roles SET primary_contact=true, updated_at=now()
 WHERE id='recEyXcKglqaJNPWV' AND primary_contact=false;

COMMIT;

-- ============================================================================
-- #13 — Same-name people: 2 merges + 4 confirmed-different
-- ============================================================================
-- 6 name pairs flagged by audit. Cross-referenced employer (PERs), email
-- domain, address, and online research:
--   Beth Anderson    — Hill Center NC vs MA Public Charter Assoc           (different)
--   David McKnight   — Power of Zero author vs NAM Mfg Institute VP        (different)
--   Josh Engel       — Border States MN vs EdSurge/ISTE Sr Director        (different)
--   Scott Burns      — Walton Family Foundation vs GovDelivery CEO MN      (different)
--   Dominque Burgess — Wildflower Foundation vs burbrellaeducation.com     (SAME, merge)
--   Ted Quinn        — Wildflower Foundation vs tcquinn.org personal site  (SAME, merge)
-- See RESEARCH_QUEUE.md R6 (resolved) for the merge rationale.

DO $$
DECLARE
  pair record;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('reciB5Lfg6MgJb84q', 'rec5dkuXrNWQyDk5P'),  -- Dominque Burgess: loser → Wildflower-Foundation winner
      ('recxOIfD5BCEYw7hi', 'rec5rOo1sEIAUBLd3')   -- Ted Quinn:        loser → Wildflower-Foundation winner
    ) AS t(loser, winner)
  LOOP
    -- Reassign every column in the schema that references people.id, then
    -- delete the loser. Idempotent: after first run the loser no longer
    -- exists so all UPDATEs hit 0 rows and the DELETE is a no-op.
    UPDATE people_entity_roles       SET person_id=pair.winner                     WHERE person_id=pair.loser;
    UPDATE emails                    SET person_id=pair.winner                     WHERE person_id=pair.loser;
    UPDATE phone_numbers             SET person_id=pair.winner                     WHERE person_id=pair.loser;
    UPDATE addresses                 SET person_id=pair.winner                     WHERE person_id=pair.loser;
    UPDATE gifts_and_payments        SET individual_giver_person_id=pair.winner    WHERE individual_giver_person_id=pair.loser;
    UPDATE gifts_and_payments        SET primary_contact_person_id=pair.winner     WHERE primary_contact_person_id=pair.loser;
    UPDATE gifts_and_payments        SET advisor_person_id=pair.winner             WHERE advisor_person_id=pair.loser;
    UPDATE opportunities_and_pledges SET individual_giver_person_id=pair.winner    WHERE individual_giver_person_id=pair.loser;
    UPDATE opportunities_and_pledges SET primary_contact_person_id=pair.winner     WHERE primary_contact_person_id=pair.loser;
    UPDATE opportunities_and_pledges SET individual_advisor_person_id=pair.winner  WHERE individual_advisor_person_id=pair.loser;
    UPDATE people                    SET assistant_person_id=pair.winner           WHERE assistant_person_id=pair.loser AND id <> pair.winner;
    DELETE FROM people               WHERE id=pair.loser;
  END LOOP;
END $$;

-- ============================================================================
-- #14 — 6 empty households: investigation outcome (KEPT as stubs)
-- ============================================================================
-- Audit flagged 6 households with no people, gifts, opps, addresses, or
-- emails (Crown, Deedie and Rusty Rose, James Kelley & Amie Knox, Mortenson,
-- Nina & Caper de Clercq, Walton Family). An initial fixup deleted them, but
-- a deeper Airtable audit (people / PER / gifts / opps tables, plus the
-- Copper companies export) confirmed they are TRULY orphaned in the source
-- data — no record anywhere references them. They are well-known donor
-- families that the team will populate manually; we keep them as
-- placeholders rather than delete and lose the seed. No SQL fixup needed
-- here; they import correctly from Airtable on every re-run.
