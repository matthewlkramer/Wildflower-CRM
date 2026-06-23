-- Migration 0070: Copper "Won" reconciliation — restore & re-code the verified
-- residual corrections (Task #359). DATA ONLY (no schema change).
--
-- ─── Background ────────────────────────────────────────────────────────────
-- A full reconciliation of the 793 Copper "Won" opportunities against PRODUCTION
-- found NO mass disappearance: 687 match prod 1:1 and the ~106 "unmatched" are
-- ~95% consolidation (the same dollars folded into a parent / merged gift). This
-- file delivers the small, verified set of genuine corrections that remain.
--
-- All record IDs were verified against the PRODUCTION DB in the planning session
-- and are the authoritative spec. NOTE: the dev DB has drifted from prod for a
-- few of these rows (e.g. the Gates/Tosha un-merge is already done in dev, and
-- the Valhalla payment gift does not exist in dev). Every statement below is
-- therefore written to be (a) idempotent / re-runnable and (b) FK-safe — an
-- INSERT that depends on a parent row no-ops cleanly when that parent is absent,
-- and every UPDATE sets an absolute target guarded so a re-run touches 0 rows.
--
-- ─── Apply (psql -1 wraps the whole file in ONE transaction; NO BEGIN/COMMIT
--     here) ────────────────────────────────────────────────────────────────
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0070_copper_won_reconciliation.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0070_copper_won_reconciliation.sql   (prod)
--
-- See 0070_copper_won_reconciliation_RUNBOOK.md for the full present /
-- consolidated / absent / re-coded classification and verification queries.
--
-- ─── NOW INCLUDED (were previously deferred) ───────────────────────────────
--   * Klau $20k (Copper 23839978) — step 4.7, donor = Rick & Molly Klau HOUSEHOLD.
--   * Stranahan pledge restructure (2 x $300k) + full regrant rebuild — step 7.
--
-- ─── STILL DEFERRED (NOT in this file — see runbook) ───────────────────────
--   * Stranahan FY21 "Wildwood" $30k regrant — booked (step 7) but its school link
--     is NULL: Wildwood is absent from the CRM schools table in BOTH dev and prod.
--     Link the school once a Wildwood record exists (e.g. an Airtable schools sync).
--   * Nash FY21 remaining $10k row + separate $7k "Goldenrod" gift — not in the
--     Copper FY21 Nash regrant list; need Copper reconciliation first.
--   * Government grants (CMO Replication FY27/FY28, USDOE pass-through) — out of
--     scope, deferred to the separate government-grants discussion.


-- ===========================================================================
-- STEP 2 — Mackenzie Scott $7M allocation re-code (NET-ZERO).
-- ===========================================================================
-- Gift recEYnjOAlCR4a5Lu. Re-distribute three of the six allocation rows to new
-- absolute targets; the $7,000,000 header total is unchanged. The other three
-- rows ($1M BWF, $500k sunlight loan fund, $1M fy26) are intentionally NOT
-- touched. No "immediate" usage enum exists, so the re-coded rows stay gen_ops.
-- Each UPDATE is guarded on its expected current value so a re-run is a no-op.

UPDATE gift_allocations
   SET sub_amount = 1500000.00, updated_at = now()
 WHERE id = 'rec1KYRaTjQbwFrMp' AND gift_id = 'recEYnjOAlCR4a5Lu'
   AND sub_amount = 2000000.00;            -- fy24 $2.0M -> $1.5M

UPDATE gift_allocations
   SET sub_amount = 1250000.00, updated_at = now()
 WHERE id = 'reckYf51uH1W7vsGc' AND gift_id = 'recEYnjOAlCR4a5Lu'
   AND sub_amount = 1500000.00;            -- fy25 $1.5M -> $1.25M

UPDATE gift_allocations
   SET sub_amount = 1750000.00, updated_at = now()
 WHERE id = 'rec6iPzv7CE3QnvGD' AND gift_id = 'recEYnjOAlCR4a5Lu'
   AND sub_amount = 1000000.00;            -- fy23 gen_ops $1.0M -> $1.75M


-- ===========================================================================
-- STEP 3 — Valhalla FY23 $500k allocation.
-- ===========================================================================
-- The existing FY23 payment gift F-mLU13c5LshbcHAt2dwC ($500k, 2023-02-13) on
-- pledge recbBm2mvG1eRHraa currently has ZERO allocations. Insert one $500k
-- allocation. FK-safe (only inserts if the gift exists — it does in prod, not in
-- dev) and idempotent (only if the gift has no allocation yet).

INSERT INTO gift_allocations
  (id, gift_id, sub_amount, grant_year, entity_id, intended_usage,
   region_ids, restriction_type)
SELECT 'ga-valhalla-F-mLU13c5LshbcHAt2dwC', 'F-mLU13c5LshbcHAt2dwC',
       500000.00, 'fy2023', 'wildflower_foundation', 'gen_ops',
       ARRAY['united_states']::text[], 'unclear'
 WHERE EXISTS (SELECT 1 FROM gifts_and_payments g
                WHERE g.id = 'F-mLU13c5LshbcHAt2dwC')
   AND NOT EXISTS (SELECT 1 FROM gift_allocations a
                    WHERE a.gift_id = 'F-mLU13c5LshbcHAt2dwC');


-- ===========================================================================
-- STEP 4 — Restore the truly-absent Copper "Won" gifts.
-- ===========================================================================
-- Each: deterministic synthetic PK 'copper-<copperId>', legacy_gift_id = Copper
-- id, Donor XOR (exactly one of org / person / household), and >= 1 allocation.
-- Default intended_usage = gen_ops and restriction_type = 'unclear' unless noted.
-- Guarded on NOT EXISTS by BOTH the synthetic PK and the legacy_gift_id, so a
-- later Airtable re-import that adds the same gift under its rec-id can't produce
-- a duplicate. Allocations are FK-safe (insert only if the parent gift exists)
-- and idempotent (insert only if absent).
--
-- (Klau / Fidelity $20k — Copper 23839978 — is restored in 4.7 as a HOUSEHOLD
--  gift per the user's donor-attribution decision: the advisors Rick & Molly Klau,
--  not the Fidelity Charitable DAF. See runbook.)

-- 4.1 Maddox "Zinnia Gift FY18" $24,000 — Copper 8002495, 2018-04-13.
INSERT INTO gifts_and_payments
  (id, legacy_gift_id, name, date_received, amount, organization_id, type, grant_year)
SELECT 'copper-8002495', '8002495', 'Zinnia Gift FY18', DATE '2018-04-13',
       24000.00, 'recnmL7uNKTAQpZg2', 'standard_gift', 'fy2018'
 WHERE NOT EXISTS (SELECT 1 FROM gifts_and_payments
                    WHERE id = 'copper-8002495' OR legacy_gift_id = '8002495');

INSERT INTO gift_allocations
  (id, gift_id, sub_amount, grant_year, entity_id, intended_usage,
   school_recipient_id, restriction_type)
SELECT 'ga-copper-8002495', 'copper-8002495', 24000.00, 'fy2018',
       'wildflower_foundation', 'school_startup', 'recWDdzadbfzlnLlF', 'unclear'
 WHERE EXISTS (SELECT 1 FROM gifts_and_payments WHERE id = 'copper-8002495')
   AND NOT EXISTS (SELECT 1 FROM gift_allocations WHERE id = 'ga-copper-8002495');

-- 4.2 Sauer Renewal (ECE/K-12) $20,000 — Copper 19826757, 2020-07-15 (FY21).
INSERT INTO gifts_and_payments
  (id, legacy_gift_id, name, date_received, amount, organization_id, type, grant_year)
SELECT 'copper-19826757', '19826757', 'Sauer Renewal (ECE/K-12)',
       DATE '2020-07-15', 20000.00, 'recXsKWPyEdi4MW0f', 'standard_gift', 'fy2021'
 WHERE NOT EXISTS (SELECT 1 FROM gifts_and_payments
                    WHERE id = 'copper-19826757' OR legacy_gift_id = '19826757');

INSERT INTO gift_allocations
  (id, gift_id, sub_amount, grant_year, entity_id, intended_usage, restriction_type)
SELECT 'ga-copper-19826757', 'copper-19826757', 20000.00, 'fy2021',
       'wildflower_foundation', 'gen_ops', 'unclear'
 WHERE EXISTS (SELECT 1 FROM gifts_and_payments WHERE id = 'copper-19826757')
   AND NOT EXISTS (SELECT 1 FROM gift_allocations WHERE id = 'ga-copper-19826757');

-- 4.3 Sauer FY24 Renewal $20,000 — Copper 26819504, 2023-06-28.
--     Booked to fy2024 per the gift name (the receipt date 2023-06-28 falls two
--     days inside fy2023; the name's "FY24" reflects the intended booking year).
INSERT INTO gifts_and_payments
  (id, legacy_gift_id, name, date_received, amount, organization_id, type, grant_year)
SELECT 'copper-26819504', '26819504', 'Sauer FY24 Renewal',
       DATE '2023-06-28', 20000.00, 'recXsKWPyEdi4MW0f', 'standard_gift', 'fy2024'
 WHERE NOT EXISTS (SELECT 1 FROM gifts_and_payments
                    WHERE id = 'copper-26819504' OR legacy_gift_id = '26819504');

INSERT INTO gift_allocations
  (id, gift_id, sub_amount, grant_year, entity_id, intended_usage, restriction_type)
SELECT 'ga-copper-26819504', 'copper-26819504', 20000.00, 'fy2024',
       'wildflower_foundation', 'gen_ops', 'unclear'
 WHERE EXISTS (SELECT 1 FROM gifts_and_payments WHERE id = 'copper-26819504')
   AND NOT EXISTS (SELECT 1 FROM gift_allocations WHERE id = 'ga-copper-26819504');

-- 4.4 Mortenson Renewal FY23 $20,000 — Copper 26273518, 2022-10-07 (FY23).
INSERT INTO gifts_and_payments
  (id, legacy_gift_id, name, date_received, amount, organization_id, type, grant_year)
SELECT 'copper-26273518', '26273518', 'Mortenson Renewal FY23',
       DATE '2022-10-07', 20000.00, 'recIDJIhAo1tuXS3A', 'standard_gift', 'fy2023'
 WHERE NOT EXISTS (SELECT 1 FROM gifts_and_payments
                    WHERE id = 'copper-26273518' OR legacy_gift_id = '26273518');

INSERT INTO gift_allocations
  (id, gift_id, sub_amount, grant_year, entity_id, intended_usage, restriction_type)
SELECT 'ga-copper-26273518', 'copper-26273518', 20000.00, 'fy2023',
       'wildflower_foundation', 'gen_ops', 'unclear'
 WHERE EXISTS (SELECT 1 FROM gifts_and_payments WHERE id = 'copper-26273518')
   AND NOT EXISTS (SELECT 1 FROM gift_allocations WHERE id = 'ga-copper-26273518');

-- 4.5 20/22 Act FY26 $20,000 — Copper 36666461, 2026-01-05 (FY26).
INSERT INTO gifts_and_payments
  (id, legacy_gift_id, name, date_received, amount, organization_id, type, grant_year)
SELECT 'copper-36666461', '36666461', '20/22 Act FY26',
       DATE '2026-01-05', 20000.00, 'recRGn3fb67g5TCuH', 'standard_gift', 'fy2026'
 WHERE NOT EXISTS (SELECT 1 FROM gifts_and_payments
                    WHERE id = 'copper-36666461' OR legacy_gift_id = '36666461');

INSERT INTO gift_allocations
  (id, gift_id, sub_amount, grant_year, entity_id, intended_usage, restriction_type)
SELECT 'ga-copper-36666461', 'copper-36666461', 20000.00, 'fy2026',
       'wildflower_foundation', 'gen_ops', 'unclear'
 WHERE EXISTS (SELECT 1 FROM gifts_and_payments WHERE id = 'copper-36666461')
   AND NOT EXISTS (SELECT 1 FROM gift_allocations WHERE id = 'ga-copper-36666461');

-- 4.6 Anonymous stock gift $20,071 — Copper 35272606, 2025-09-05 (FY26).
--     Donor is a PERSON (Anonymous Seed Fund Donor); payment_method = stock.
INSERT INTO gifts_and_payments
  (id, legacy_gift_id, name, date_received, amount, individual_giver_person_id,
   type, payment_method, grant_year)
SELECT 'copper-35272606', '35272606', 'Anonymous stock gift',
       DATE '2025-09-05', 20071.00, 'reckcWrAIWUfuh8mU', 'standard_gift',
       'stock', 'fy2026'
 WHERE NOT EXISTS (SELECT 1 FROM gifts_and_payments
                    WHERE id = 'copper-35272606' OR legacy_gift_id = '35272606');

INSERT INTO gift_allocations
  (id, gift_id, sub_amount, grant_year, entity_id, intended_usage, restriction_type)
SELECT 'ga-copper-35272606', 'copper-35272606', 20071.00, 'fy2026',
       'wildflower_foundation', 'gen_ops', 'unclear'
 WHERE EXISTS (SELECT 1 FROM gifts_and_payments WHERE id = 'copper-35272606')
   AND NOT EXISTS (SELECT 1 FROM gift_allocations WHERE id = 'ga-copper-35272606');

-- 4.7 Klau $20,000 (Flame Lily startup) — Copper 23839978, 2021-02-02 (FY21).
--     Donor decision (user-confirmed): the advisors Rick & Molly Klau, recorded as
--     their HOUSEHOLD 'Rick and Molly Klau' (recE2xUxjviG0RowP), NOT the Fidelity
--     Charitable DAF. Allocation → Flame Lily school, school_startup, fy2021.
INSERT INTO gifts_and_payments
  (id, legacy_gift_id, name, date_received, amount, household_id, type, grant_year)
SELECT 'copper-23839978', '23839978', 'Klau Flame Lily startup',
       DATE '2021-02-02', 20000.00, 'recE2xUxjviG0RowP', 'standard_gift', 'fy2021'
 WHERE NOT EXISTS (SELECT 1 FROM gifts_and_payments
                    WHERE id = 'copper-23839978' OR legacy_gift_id = '23839978');

INSERT INTO gift_allocations
  (id, gift_id, sub_amount, grant_year, entity_id, intended_usage,
   school_recipient_id, restriction_type)
SELECT 'ga-copper-23839978', 'copper-23839978', 20000.00, 'fy2021',
       'wildflower_foundation', 'school_startup', 'recMfJhJlMpnYzQ0x', 'unclear'
 WHERE EXISTS (SELECT 1 FROM gifts_and_payments WHERE id = 'copper-23839978')
   AND NOT EXISTS (SELECT 1 FROM gift_allocations WHERE id = 'ga-copper-23839978');


-- ===========================================================================
-- STEP 5 — Gates / Tosha matching-gift pair (un-merge).
-- ===========================================================================
-- PROD state (authoritative): ONE merged $3,500 Gates gift recGpltnPNwQQXuQ3
-- (donor Gates org, legacy 33657848) with two allocations:
--   synth-ga-recGpltnPNwQQXuQ3 $875  (BWF fy2025)  -> Tosha Downey's gift
--   synth-ga-recYeA9b5NLTUTWUE $2625 (BWF fy2025)  -> Gates matching gift
-- DEV is already un-merged (recYeA9b5NLTUTWUE exists as a separate $2,625
-- matching gift) but with the donor on recGpltnPNwQQXuQ3 still Gates and the
-- matching gift's gift_being_matched_id NULL. The statements below converge BOTH
-- environments to the correct end state:
--   recGpltnPNwQQXuQ3 = the $875 Tosha Downey gift
--   recYeA9b5NLTUTWUE = the $2,625 Gates matching gift, matching the $875 gift.
--
-- Per the schema, the MATCHING gift carries gift_being_matched_id pointing at the
-- gift being matched (giftsAndPayments.giftBeingMatchedId self-ref).

-- 5.1 Ensure the $2,625 Gates matching gift exists (no-op in dev where it does).
--     date_received copied from the gift it matches (a defensible default; Copper
--     carried no distinct match date).
INSERT INTO gifts_and_payments
  (id, legacy_gift_id, name, amount, organization_id, type,
   gift_being_matched_id, grant_year, date_received)
SELECT 'recYeA9b5NLTUTWUE', '33657831',
       'FY25 $2625 Gates matching grant for Tosha Downey', 2625.00,
       'recmFiVt4H3XWM4dE', 'matching_gift', 'recGpltnPNwQQXuQ3', 'fy2025',
       (SELECT date_received FROM gifts_and_payments WHERE id = 'recGpltnPNwQQXuQ3')
 WHERE EXISTS (SELECT 1 FROM gifts_and_payments WHERE id = 'recGpltnPNwQQXuQ3')
   AND NOT EXISTS (SELECT 1 FROM gifts_and_payments WHERE id = 'recYeA9b5NLTUTWUE');

-- 5.2 Converge the matching gift to its target field values (fixes the dev row,
--     re-affirms the prod insert). Donor XOR: Gates org only.
UPDATE gifts_and_payments
   SET name                       = 'FY25 $2625 Gates matching grant for Tosha Downey',
       amount                     = 2625.00,
       organization_id            = 'recmFiVt4H3XWM4dE',
       individual_giver_person_id = NULL,
       household_id               = NULL,
       type                       = 'matching_gift',
       legacy_gift_id             = '33657831',
       gift_being_matched_id      = 'recGpltnPNwQQXuQ3',
       updated_at                 = now()
 WHERE id = 'recYeA9b5NLTUTWUE'
   AND (gift_being_matched_id IS DISTINCT FROM 'recGpltnPNwQQXuQ3'
        OR type IS DISTINCT FROM 'matching_gift'
        OR organization_id IS DISTINCT FROM 'recmFiVt4H3XWM4dE'
        OR individual_giver_person_id IS NOT NULL);

-- 5.3 Move the $2,625 allocation off the (formerly merged) gift onto the matching
--     gift. No-op in dev (already parented to recYeA9b5NLTUTWUE).
UPDATE gift_allocations
   SET gift_id = 'recYeA9b5NLTUTWUE', updated_at = now()
 WHERE id = 'synth-ga-recYeA9b5NLTUTWUE'
   AND gift_id = 'recGpltnPNwQQXuQ3';

-- 5.4 Repurpose recGpltnPNwQQXuQ3 as the $875 Tosha Downey gift. Donor XOR:
--     individual (Tosha) only; clears the Gates org. amount 3500 -> 875 (no-op in
--     dev where it is already 875). Keeps legacy 33657848 and the $875 allocation.
UPDATE gifts_and_payments
   SET name                       = 'FY25 $875 Downey to BWF',
       amount                     = 875.00,
       organization_id            = NULL,
       individual_giver_person_id = 'rec5mpAQy007hRwoW',
       household_id               = NULL,
       type                       = 'standard_gift',
       legacy_gift_id             = '33657848',
       updated_at                 = now()
 WHERE id = 'recGpltnPNwQQXuQ3'
   AND (organization_id IS NOT NULL
        OR individual_giver_person_id IS DISTINCT FROM 'rec5mpAQy007hRwoW'
        OR amount IS DISTINCT FROM 875.00);


-- ===========================================================================
-- STEP 6 — Hub regrants: link allocations to recipient schools.
-- ===========================================================================
-- CONSOLIDATION FIX, NOT new money. These regrants already exist as allocation
-- dollars on the parent funder gift but with school_recipient_id = NULL. Set the
-- school on the matching allocation rows. Only the unambiguous mappings (amount
-- AND, where present, region agree with the Copper "Won" source) are written;
-- the rest are surfaced in the runbook, not guessed. Each UPDATE is guarded on
-- school_recipient_id IS NULL so a re-run touches 0 rows. Setting
-- school_recipient_id fires the display_usage trigger automatically.

-- 6a. Nash / Indira FY21, parent "Nash FY21 startup grants" $75k rec2twqm58PjFRhhf.
--     Region on each allocation confirms the school:
--       $25k recdbFJZ0KbLBNwak  (CA Bay Area) -> Sundrops   receVvowYpahON8C6
--       $20k rece7Ccdyy0nKcfcq  (CO)          -> Flame Lily recMfJhJlMpnYzQ0x
--       $20k reco8ENNbxNwTimot  (MA)          -> Lotus      recpGvUU0FBucwxPo
--     DEFERRED: the remaining $10k row (recg5uQrZgnWm9FQf) and the separate $7k
--     "Goldenrod" gift (rec6B0yqPIR47JbIa) — not in the Copper FY21 Nash regrant
--     list; reconcile against Copper before linking. See runbook.
UPDATE gift_allocations
   SET school_recipient_id = 'receVvowYpahON8C6', updated_at = now()
 WHERE id = 'recdbFJZ0KbLBNwak' AND gift_id = 'rec2twqm58PjFRhhf'
   AND school_recipient_id IS NULL;

UPDATE gift_allocations
   SET school_recipient_id = 'recMfJhJlMpnYzQ0x', updated_at = now()
 WHERE id = 'rece7Ccdyy0nKcfcq' AND gift_id = 'rec2twqm58PjFRhhf'
   AND school_recipient_id IS NULL;

UPDATE gift_allocations
   SET school_recipient_id = 'recpGvUU0FBucwxPo', updated_at = now()
 WHERE id = 'reco8ENNbxNwTimot' AND gift_id = 'rec2twqm58PjFRhhf'
   AND school_recipient_id IS NULL;

-- 6b. Nash -> Jun Zi Lan $10k — Copper 25936948, 2022-09-09 (FY23). Split the
--     single $70k allocation on the FY23 Nash parent "Avi Nash FY23 (payment 2)"
--     reci8qgNnjGYbC1os into $60k + a new $10k allocation linked to Jun Zi Lan
--     school recWvpgrgXEFDY9gw. Net total on the parent stays $70k.
UPDATE gift_allocations
   SET sub_amount = 60000.00, updated_at = now()
 WHERE id = 'synth-ga-reci8qgNnjGYbC1os' AND gift_id = 'reci8qgNnjGYbC1os'
   AND sub_amount = 70000.00;

INSERT INTO gift_allocations
  (id, gift_id, sub_amount, grant_year, entity_id, intended_usage,
   school_recipient_id, region_ids, restriction_type)
SELECT 'ga-copper-25936948', 'reci8qgNnjGYbC1os', 10000.00, 'fy2023',
       'wildflower_foundation', 'school_startup', 'recWvpgrgXEFDY9gw',
       ARRAY['united_states']::text[], 'unclear'
 WHERE EXISTS (SELECT 1 FROM gifts_and_payments WHERE id = 'reci8qgNnjGYbC1os')
   AND NOT EXISTS (SELECT 1 FROM gift_allocations WHERE id = 'ga-copper-25936948');

-- ===========================================================================
-- STEP 7 — Stranahan Foundation pledge restructure (user-confirmed).
-- ===========================================================================
-- The $600k Stranahan pledge (header rec8J1Lbc9jYMzG5d, already $600k in prod —
-- intentionally NOT modified here) is two equal $300k payments, one per fiscal
-- year. QuickBooks (prod) shows the two incoming payments:
--     2021-01-26  $300,000  (FY21)  -> keep existing gift recwKC3JHKRY2QYHe
--     2021-12-13  $300,000  (FY22)  -> new gift stranahan-fy22-payment
-- This SUPERSEDES the former step 6c (which linked Clover/Goldenrod on the old
-- $225k single-payment shape); all nine legacy allocations on recwKC3JHKRY2QYHe
-- are dropped and the regrant schedule is rebuilt across the two payments.
--
-- Coding note: each regrant is linked to its recipient school. entity_id,
-- restriction_type (unclear) and intended_usage are defaulted uniformly to the
-- school-regrant pattern (intended_usage = 'school_startup'); region_ids are
-- left null because the school link is the precise scope. Adjust per-row in the
-- app if any line is actually general-operating support. See runbook.
--
-- WILDWOOD FLAG: the FY21 $30k "Wildwood" regrant is booked with
-- school_recipient_id = NULL because Wildwood does not exist in the CRM schools
-- table (absent in BOTH dev and prod — it predates/postdates the one-time
-- Airtable seed; there is no live Airtable->schools sync). The dollars still tie
-- to $300k; link the school once a Wildwood record exists. See runbook.

-- 7.1 Raise the existing FY21 payment to $300k and stamp the QuickBooks date.
UPDATE gifts_and_payments
   SET amount = 300000.00, date_received = DATE '2021-01-26', updated_at = now()
 WHERE id = 'recwKC3JHKRY2QYHe'
   AND (amount IS DISTINCT FROM 300000.00
        OR date_received IS DISTINCT FROM DATE '2021-01-26');

-- 7.2 Mint the FY22 $300k payment gift on the same pledge + donor (FK-safe).
INSERT INTO gifts_and_payments
  (id, name, date_received, amount, organization_id, type,
   payment_on_pledge_id, grant_year)
SELECT 'stranahan-fy22-payment', 'Stranahan Foundation 2022 (payment 2)',
       DATE '2021-12-13', 300000.00, 'recLn1w2ZuhFJBvR0', 'pledge_payment',
       'rec8J1Lbc9jYMzG5d', 'fy2022'
 WHERE EXISTS (SELECT 1 FROM opportunities_and_pledges WHERE id = 'rec8J1Lbc9jYMzG5d')
   AND EXISTS (SELECT 1 FROM organizations WHERE id = 'recLn1w2ZuhFJBvR0')
   AND NOT EXISTS (SELECT 1 FROM gifts_and_payments WHERE id = 'stranahan-fy22-payment');

-- 7.3 Drop the nine legacy allocations on the FY21 gift. Idempotent: the rebuilt
--     FY21 rows all carry the 'ga-stranahan-fy21-' prefix and are excluded, so a
--     re-run (only rebuilt rows remain) deletes 0.
DELETE FROM gift_allocations
 WHERE gift_id = 'recwKC3JHKRY2QYHe'
   AND id NOT LIKE 'ga-stranahan-fy21-%';

-- 7.4 Rebuild the FY21 regrant schedule under recwKC3JHKRY2QYHe (sum = $300,000).
INSERT INTO gift_allocations
  (id, gift_id, sub_amount, grant_year, entity_id, intended_usage,
   school_recipient_id, restriction_type)
SELECT v.id, 'recwKC3JHKRY2QYHe', v.sub_amount, 'fy2021',
       'wildflower_foundation', 'school_startup', v.school_recipient_id, 'unclear'
FROM (VALUES
  ('ga-stranahan-fy21-recqb4kSIDJprmyF8', 30000.00, 'recqb4kSIDJprmyF8'),  -- Rain Lily
  ('ga-stranahan-fy21-recdotNcbKJ6gg0hT', 35000.00, 'recdotNcbKJ6gg0hT'),  -- Goldenrod
  ('ga-stranahan-fy21-recCShp260kWj4YPp', 30000.00, 'recCShp260kWj4YPp'),  -- Weetumuw (Mukayuhsak)
  ('ga-stranahan-fy21-wildwood',          30000.00, NULL),                 -- Wildwood (absent; see flag)
  ('ga-stranahan-fy21-recjNJFRasbWLQUX4', 50000.00, 'recjNJFRasbWLQUX4'),  -- Roxbury Roots
  ('ga-stranahan-fy21-recbBfMCZZaPELTD0', 15000.00, 'recbBfMCZZaPELTD0'),  -- Snowdrop Haverhill
  ('ga-stranahan-fy21-recnzeYycsq2HILuP', 45000.00, 'recnzeYycsq2HILuP'),  -- Sage
  ('ga-stranahan-fy21-receVvowYpahON8C6', 15000.00, 'receVvowYpahON8C6'),  -- Sundrops
  ('ga-stranahan-fy21-recmlQq7U0fTHLpgq',  5000.00, 'recmlQq7U0fTHLpgq'),  -- Blazing Stars (FY21)
  ('ga-stranahan-fy21-recMOMI1tHqVtkcCb', 45000.00, 'recMOMI1tHqVtkcCb')   -- Clover
) AS v(id, sub_amount, school_recipient_id)
WHERE EXISTS (SELECT 1 FROM gifts_and_payments g WHERE g.id = 'recwKC3JHKRY2QYHe')
  AND NOT EXISTS (SELECT 1 FROM gift_allocations a WHERE a.id = v.id);

-- 7.5 Build the FY22 regrant schedule under stranahan-fy22-payment (sum = $300,000).
INSERT INTO gift_allocations
  (id, gift_id, sub_amount, grant_year, entity_id, intended_usage,
   school_recipient_id, restriction_type)
SELECT v.id, 'stranahan-fy22-payment', v.sub_amount, 'fy2022',
       'wildflower_foundation', 'school_startup', v.school_recipient_id, 'unclear'
FROM (VALUES
  ('ga-stranahan-fy22-recValrVtyr0ld1h2', 40000.00, 'recValrVtyr0ld1h2'),  -- Honeypot
  ('ga-stranahan-fy22-recmlQq7U0fTHLpgq', 25000.00, 'recmlQq7U0fTHLpgq'),  -- Blazing Stars (FY22)
  ('ga-stranahan-fy22-recMfJhJlMpnYzQ0x', 30000.00, 'recMfJhJlMpnYzQ0x'),  -- Flame Lily
  ('ga-stranahan-fy22-recyCBZ987lLOrF91', 30000.00, 'recyCBZ987lLOrF91'),  -- Riverseed
  ('ga-stranahan-fy22-recIMwRT1vmp6XSTf', 20000.00, 'recIMwRT1vmp6XSTf'),  -- Desert Peach
  ('ga-stranahan-fy22-rec5LAcULpfZhvycx', 20000.00, 'rec5LAcULpfZhvycx'),  -- Spicebush
  ('ga-stranahan-fy22-recVGdwxtApUmkB7B', 20000.00, 'recVGdwxtApUmkB7B'),  -- Acacia
  ('ga-stranahan-fy22-recU6oOUBWzPZQUDI', 30000.00, 'recU6oOUBWzPZQUDI'),  -- Orchid
  ('ga-stranahan-fy22-recdyWjvnQlTgVbyA', 45000.00, 'recdyWjvnQlTgVbyA'),  -- Ixora
  ('ga-stranahan-fy22-recsohdntvNNEvFu0', 20000.00, 'recsohdntvNNEvFu0'),  -- Bronx Chrysalis
  ('ga-stranahan-fy22-recn4k7WtNOHVxuki', 20000.00, 'recn4k7WtNOHVxuki')   -- Sankofa
) AS v(id, sub_amount, school_recipient_id)
WHERE EXISTS (SELECT 1 FROM gifts_and_payments g WHERE g.id = 'stranahan-fy22-payment')
  AND NOT EXISTS (SELECT 1 FROM gift_allocations a WHERE a.id = v.id);
