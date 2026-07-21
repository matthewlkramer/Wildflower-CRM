-- Migration 0147: One-time allocation restriction cleanup for historical
-- gifts and pledges (owner-reviewed, per-row dispositions).
--
-- Historical gift/pledge allocations were never coded on the three
-- restriction axes, and ~21 gift allocations carried a stray
-- intended_usage='project' with no project linked. The owner reviewed every
-- affected row; this file applies the per-row dispositions. It is a one-time
-- data cleanup — NO ongoing rule, trigger, or app-code change.
--
-- SAFE TO RE-RUN:
--   - reference rows are INSERT ... ON CONFLICT DO NOTHING
--   - updates are keyed by allocation id with absolute SET values
--   - the SPP FY20 splits guard the in-place update on the current $40k
--     state and insert the two new rows with fixed deterministic ids
--     ON CONFLICT DO NOTHING (a re-run cannot duplicate rows; the gift keeps
--     >= 1 allocation at every point)
--
-- display_usage on gift_allocations is trigger-maintained — never set
-- directly; the UPDATEs/INSERTs below refresh it automatically.
--
-- Applied with psql -1 (single transaction) — do NOT add BEGIN/COMMIT.
-- Run against prod:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0147_allocation_restriction_cleanup.sql

-- ── Step 1: reference rows ───────────────────────────────────────────────────
-- Expected: 1 row each on first apply; 0 on re-run.

INSERT INTO entities (id, name, active, fiscally_sponsored, expects_payment)
VALUES ('partnership_passthrough', 'Partnership Passthrough', true, false, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO fundable_projects (id, name)
VALUES
  ('minnesota_wei', 'Minnesota WEI'),
  ('observation_support_tech_development_deck', 'Observation Support Tech Development Deck')
ON CONFLICT (id) DO NOTHING;

INSERT INTO regions (id, name, display_path, state_abbreviation, type, parent_region_id)
VALUES
  ('united_states__colorado__littleton', 'Littleton',
   'United States, Colorado, Littleton', NULL, 'city', 'united_states__colorado'),
  ('united_states__new_jersey__central_new_jersey', 'Central New Jersey',
   'United States, New Jersey, Central New Jersey', NULL, 'region_within_state',
   'united_states__new_jersey')
ON CONFLICT (id) DO NOTHING;

-- ── Step 2: gift allocation dispositions ─────────────────────────────────────

-- Group 1 — usage_restriction_type -> donor_restricted (project links already
-- correct). Expected: 4 rows.
UPDATE gift_allocations
SET usage_restriction_type = 'donor_restricted', updated_at = NOW()
WHERE id IN (
  'synth-ga-recbirvqCdEmatP5x',  -- Fidelity Foundations, FY23 Anonymous SSJ $580k
  'synth-ga-recLUda8QWJMtoHa0',  -- Fidelity Foundations, FY25 $200k Anon MA SSJ Phase II
  'synth-ga-recKW139NRqZMhOL4',  -- CSGF Observation Support Tech $500k
  'synth-ga-recI0soD5YTwzRP3H'   -- Gates Tech Research Exploration $249,917
);

-- Group 2 — usage_restriction_type -> wf_restricted. Expected: 2 rows.
-- (McKnight's regional_restriction_type stays donor_restricted — untouched.)
UPDATE gift_allocations
SET usage_restriction_type = 'wf_restricted', updated_at = NOW()
WHERE id IN (
  'synth-ga-recReHXt8wdJxqRwL',  -- McKnight FY24 $25k board designated ($12.5k slice)
  'synth-ga-recq19tTWDNtZgsKr'   -- MDRC $15k FY23 Observant Ed stipend
);

-- Group 3 — clear stray project usage, donor_restricted, set purpose_verbatim.
-- Expected: 5 rows.
UPDATE gift_allocations ga
SET intended_usage = NULL,
    usage_restriction_type = 'donor_restricted',
    purpose_verbatim = v.purpose,
    updated_at = NOW()
FROM (VALUES
  ('synth-ga-reclJ7VAMQe17JylC', 'Alumni Grant Program'),    -- Sep Kamvar $10k
  ('synth-ga-recuRLvecG7IgHgY6', 'SGP CBD'),                 -- SGP CBD FY19 $25k
  ('synth-ga-recC60zMGSevcjLgG', 'Corina''s AMI training'),  -- $15k 2019
  ('synth-ga-recMtzet0KyZdto6t', 'SS & CI'),                 -- Spring Point $500k
  ('synth-ga-recgVF3rooMZfTZYY', 'The Exchange')             -- Dukes $5k (entity stays black_wildflowers_fund)
) AS v(id, purpose)
WHERE ga.id = v.id;

-- Group 4 — individual dispositions.

-- Sep NJ Gift 2019-02-25 $15k slice. Expected: 1 row.
UPDATE gift_allocations
SET intended_usage = NULL,
    regional_restriction_type = 'donor_restricted',
    region_ids = ARRAY['united_states__new_jersey__central_new_jersey'],
    updated_at = NOW()
WHERE id = 'recilrjIWVGN1YM7K';

-- Sep FY21 2020-12-22 $15k "NJ partnership with KYDS" slice. Expected: 1 row.
UPDATE gift_allocations
SET intended_usage = NULL,
    entity_id = 'partnership_passthrough',
    counts_toward_goal = false,
    purpose_verbatim = 'NJ partnership with KYDS',
    updated_at = NOW()
WHERE id = 'recjkLLE8wVhS4tfy';

-- Ledley Family FY20 $25k -> direct to Allium. Expected: 1 row.
UPDATE gift_allocations
SET intended_usage = 'school_startup',
    entity_id = 'direct_to_school',
    school_recipient_id = 'recpdANCtu0zk5207',  -- Allium
    usage_restriction_type = 'donor_restricted',
    updated_at = NOW()
WHERE id = 'synth-ga-reclRoZ0ellkCQCYh';

-- Transformative Black-Led Movement Fund (Borealis) $70k. Expected: 1 row.
UPDATE gift_allocations
SET intended_usage = 'school_startup',
    fundable_project_id = 'minnesota_wei',
    region_ids = ARRAY['united_states__minnesota'],
    usage_restriction_type = 'donor_restricted',
    regional_restriction_type = 'donor_restricted',
    purpose_verbatim = 'Funds will go toward startup grants for WEI cohort members',
    updated_at = NOW()
WHERE id = 'synth-ga-rec9wS6zIZrIsxIqI';

-- Telluray x2 -> Littleton CO. Expected: 2 rows.
UPDATE gift_allocations
SET intended_usage = NULL,
    regional_restriction_type = 'donor_restricted',
    region_ids = ARRAY['united_states__colorado__littleton'],
    updated_at = NOW()
WHERE id IN ('synth-ga-recA5mVTMnNohUHis', 'synth-ga-recwWGBeJuSZY7IiI');

-- Amy Gips / Anonymous Individual Donor $10k -> MCM scholarships. Expected: 1 row.
UPDATE gift_allocations
SET entity_id = 'partnership_passthrough',
    counts_toward_goal = false,
    intended_usage = 'teacher_training',
    usage_restriction_type = 'donor_restricted',
    regional_restriction_type = 'donor_restricted',
    region_ids = ARRAY['united_states__minnesota'],
    purpose_verbatim = 'Scholarships for MCM (Montessori Center of Minnesota)',
    updated_at = NOW()
WHERE id = 'synth-ga-recudCYNn4lAFEAeS';

-- Keith Tom x5 (all his SSJ tech gifts; ids verified in prod — the person has
-- exactly these five gifts). intended_usage stays 'project'. Expected: 5 rows.
UPDATE gift_allocations
SET fundable_project_id = 'ssj',  -- "My Wildflower"
    usage_restriction_type = 'donor_restricted',
    updated_at = NOW()
WHERE id IN (
  'synth-ga-recK66vALf2EAGqLz',  -- FY22 $45k 2022-01-07
  'synth-ga-recVzMXtinSLV7ErZ',  -- FY22 #2 $50k 2022-01-26
  'synth-ga-reck83TRNTHlEllpz',  -- FY22 $50k Tech Enhanced SSJ 2022-06-22
  'synth-ga-rec4otYmrfowQAPw0',  -- FY22 #3 $100k 2022-08-11
  'synth-ga-recIFKQo27eY4UAss'   -- FY26 $50k 2024-12-03
);

-- William Penn x2 -> Black Wildflowers Fund. Keeps existing Greater
-- Philadelphia region_ids. Expected: 2 rows.
UPDATE gift_allocations
SET intended_usage = NULL,
    entity_id = 'black_wildflowers_fund',
    usage_restriction_type = 'donor_restricted',
    regional_restriction_type = 'donor_restricted',
    purpose_verbatim = 'Black Wildflowers Fund',
    updated_at = NOW()
WHERE id IN ('synth-ga-recuBzTJBnXg2nNNX', 'synth-ga-recT6GdHbEEhvI4dq');

-- ── Step 3: SPP FY20 gift split (gift recaVJheMROdraT6f, $40k, 2019-12-17) ──
-- NOT the $60k gift of the same name (KYlJxI6LgdsPHitxwFxYa). Replace the
-- single $40k allocation reclDSARHtaFn68Zk with three rows. The in-place
-- update is guarded on the current $40k state so a re-run is a no-op; the two
-- inserts use fixed deterministic ids ON CONFLICT DO NOTHING and take gift_id
-- from the existing allocation (dev's gift id topology drifted, but the
-- allocation row exists in both).

-- 3a. $5,000 — Observation Support Tech Development Deck.
-- Expected: 1 row (0 on re-run).
UPDATE gift_allocations
SET sub_amount = 5000.00,
    entity_id = 'observation_support_tech',
    intended_usage = 'project',
    fundable_project_id = 'observation_support_tech_development_deck',
    usage_restriction_type = 'unrestricted',
    regional_restriction_type = 'unrestricted',
    time_restriction_type = 'unrestricted',
    region_ids = NULL,
    updated_at = NOW()
WHERE id = 'reclDSARHtaFn68Zk'
  AND sub_amount = 40000.00;

-- 3b. $15,000 — WF gen ops, unrestricted, national. Expected: 1 row (0 on re-run).
INSERT INTO gift_allocations
  (id, gift_id, sub_amount, grant_year, entity_id, intended_usage,
   usage_restriction_type, regional_restriction_type, time_restriction_type,
   region_ids)
SELECT 'ga0147-spp-fy20-gen-ops', src.gift_id, 15000.00, src.grant_year,
       'wildflower_foundation', 'gen_ops',
       'unrestricted', 'unrestricted', 'unrestricted', NULL
FROM gift_allocations src
WHERE src.id = 'reclDSARHtaFn68Zk'
ON CONFLICT (id) DO NOTHING;

-- 3c. $20,000 — WF, regionally donor-restricted to Greater Philadelphia + NJ.
-- Expected: 1 row (0 on re-run).
INSERT INTO gift_allocations
  (id, gift_id, sub_amount, grant_year, entity_id, intended_usage,
   usage_restriction_type, regional_restriction_type, time_restriction_type,
   region_ids)
SELECT 'ga0147-spp-fy20-phl-nj', src.gift_id, 20000.00, src.grant_year,
       'wildflower_foundation', NULL,
       'unrestricted', 'donor_restricted', 'unrestricted',
       ARRAY['united_states__pennsylvania__greater_philadelphia',
             'united_states__new_jersey']
FROM gift_allocations src
WHERE src.id = 'reclDSARHtaFn68Zk'
ON CONFLICT (id) DO NOTHING;

-- ── Step 4: pledge allocation dispositions ───────────────────────────────────

-- usage_restriction_type -> donor_restricted. Expected: 6 rows in prod
-- (all six exist); 6 in dev too.
UPDATE pledge_allocations
SET usage_restriction_type = 'donor_restricted', updated_at = NOW()
WHERE id IN (
  'synth-pa-rec3CKquETtrZrKQX-wildflower_foundation-fy2026',  -- FY26 MDD CSP $1.63M (US Dept of Ed)
  'rechkRoxc9rWLdIqx',   -- CZI large tech grant $2M
  'recGjCuoB3aiwiuSA',   -- CZI large tech grant $1M
  'recHRlMbVvixYrnF2',   -- CZI large tech grant $250k
  'p4B2CXohYnJ0JD_jEDFJ4',  -- Imaginable Futures $10k
  'recXalWRvBNXgcfdv'    -- FY23 Anonymous Grant for SSJ $580k
);

-- FY23 Anonymous SSJ pledge also mirrors the gift-side SSJ project coding.
-- Expected: 1 row.
UPDATE pledge_allocations
SET fundable_project_id = 'ssj', updated_at = NOW()
WHERE id = 'recXalWRvBNXgcfdv';

-- ── Step 5: SPP FY20 pledge split (mirrors the gift-side 3-way split) ───────
-- Pledge allocation h17sjkVVYjdiDMMj4F8Zc ($40k on opp "SPP FY20"). This row
-- exists ONLY in prod (dev drift: dev never had the SPP FY20 pledge), so all
-- three statements affect 0 rows in dev — that is expected and correct.
-- The inserts copy pledge_or_opportunity_id / grant_year / status from the
-- source row so they no-op when it is absent.

-- 5a. $5,000 — Observation Support Tech Development Deck.
-- Expected: 1 row in prod (0 on re-run, 0 in dev).
UPDATE pledge_allocations
SET sub_amount = 5000.00,
    entity_id = 'observation_support_tech',
    intended_usage = 'project',
    fundable_project_id = 'observation_support_tech_development_deck',
    usage_restriction_type = 'unrestricted',
    regional_restriction_type = 'unrestricted',
    time_restriction_type = 'unrestricted',
    region_ids = NULL,
    updated_at = NOW()
WHERE id = 'h17sjkVVYjdiDMMj4F8Zc'
  AND sub_amount = 40000.00;

-- 5b. $15,000 — WF gen ops, unrestricted, national.
-- Expected: 1 row in prod (0 on re-run, 0 in dev).
INSERT INTO pledge_allocations
  (id, pledge_or_opportunity_id, sub_amount, grant_year, entity_id,
   intended_usage, usage_restriction_type, regional_restriction_type,
   time_restriction_type, region_ids, status)
SELECT 'pa0147-spp-fy20-gen-ops', src.pledge_or_opportunity_id, 15000.00,
       src.grant_year, 'wildflower_foundation', 'gen_ops',
       'unrestricted', 'unrestricted', 'unrestricted', NULL, src.status
FROM pledge_allocations src
WHERE src.id = 'h17sjkVVYjdiDMMj4F8Zc'
ON CONFLICT (id) DO NOTHING;

-- 5c. $20,000 — WF, regionally donor-restricted to Greater Philadelphia + NJ.
-- Expected: 1 row in prod (0 on re-run, 0 in dev).
INSERT INTO pledge_allocations
  (id, pledge_or_opportunity_id, sub_amount, grant_year, entity_id,
   intended_usage, usage_restriction_type, regional_restriction_type,
   time_restriction_type, region_ids, status)
SELECT 'pa0147-spp-fy20-phl-nj', src.pledge_or_opportunity_id, 20000.00,
       src.grant_year, 'wildflower_foundation', NULL,
       'unrestricted', 'donor_restricted', 'unrestricted',
       ARRAY['united_states__pennsylvania__greater_philadelphia',
             'united_states__new_jersey'],
       src.status
FROM pledge_allocations src
WHERE src.id = 'h17sjkVVYjdiDMMj4F8Zc'
ON CONFLICT (id) DO NOTHING;
