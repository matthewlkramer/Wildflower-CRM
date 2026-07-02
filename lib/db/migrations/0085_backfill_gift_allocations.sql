-- 0085_backfill_gift_allocations.sql
--
-- DATA-ONLY production backfill. Inserts exactly ONE gift_allocations row for
-- each of the 32 active gifts that currently have zero allocations, plus two
-- small companion fixes (a broken donor link and a research flag). No schema or
-- app-code changes here (the mint-path seeding + backstop guard ship via the
-- normal Publish flow as separate code).
--
-- WHY: every gift must have at least one gift_allocations row — that child row is
-- where ALL money scope lives (fund entity, fiscal year, sub-amount, restriction
-- axes, region, school recipient) and revenue coding is derived from it. These 32
-- gifts came from mint paths that create a header only and relied on a follow-up
-- allocation that never happened, so they carry an amount + donor but no scope.
--
-- The booking below was confirmed with the product owner and OVERRIDES the
-- QuickBooks signal wherever they conflict (the QB "(deleted)" classes/accounts
-- are unreliable). The mapping is fully enumerated by gift id and is NOT to be
-- re-derived in code. Result: 9 gifts → Black Wildflowers Fund, 23 → Wildflower
-- Foundation.
--
--   A. Black Wildflowers Fund  (9) — entity black_wildflowers_fund,
--        usage axis donor_restricted.
--   B. Wildflower Foundation, geographically restricted (4) — entity
--        wildflower_foundation, regional axis donor_restricted, region set.
--   C. Wildflower Foundation, designated to a specific school (2) — entity
--        wildflower_foundation, school_recipient_id set (the established
--        convention: NOT the direct_to_school entity).
--   D. Wildflower Foundation, unrestricted (17) — entity wildflower_foundation,
--        all three axes unrestricted.
--
-- Every inserted row: sub_amount = the gift amount, grant_year = the Wildflower
-- fiscal year of date_received (FY runs Jul 1 – Jun 30, named by the ending year:
-- month >= 7 → next calendar year), counts_toward_goal = true. All required
-- fiscal_years rows (fy2018, fy2020..fy2024, fy2026) were verified present in
-- production before this file was written.
--
-- IDEMPOTENT: each allocation gets a deterministic id ('ga_0085_' || gift_id) and
-- is only inserted WHERE NOT EXISTS an allocation for that gift, so a re-run after
-- a successful apply is a no-op. NON-DESTRUCTIVE: no DELETEs / no overwrites of
-- existing scope. The donor fix and email insert are both guarded/idempotent.
--
-- Applied by a human (the agent cannot write prod), AFTER Publish so every
-- referenced table/column exists, from the repo root:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0085_backfill_gift_allocations.sql
--
-- NOTE: no BEGIN/COMMIT here — psql -1 wraps the whole file in one transaction.

-- ──────────────────────────────────────────────────────────────────────────
-- Pre-state (for the operator).
-- ──────────────────────────────────────────────────────────────────────────
DO $$
DECLARE n_orphans int;
BEGIN
  SELECT count(*) INTO n_orphans
    FROM gifts_and_payments g
   WHERE g.archived_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g.id);
  RAISE NOTICE '0085: active gifts with ZERO allocations BEFORE = % (expect 32 on first apply, 0 on re-run)', n_orphans;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- Step 1: backfill one allocation per orphan gift (sections A–D).
--
-- A single INSERT ... SELECT joins each gift to its enumerated booking (m). The
-- sub_amount and grant_year are read from the gift itself (amount + fiscal year
-- of date_received), so they always match the live gift; the entity / restriction
-- axes / region / school come from the reviewed mapping. Guarded by NOT EXISTS so
-- it never touches a gift that already has an allocation.
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO gift_allocations (
  id, gift_id, sub_amount, grant_year, entity_id,
  regional_restriction_type, usage_restriction_type, time_restriction_type,
  region_ids, school_recipient_id, counts_toward_goal, created_at, updated_at
)
SELECT
  'ga_0085_' || g.id,
  g.id,
  g.amount,
  'fy' || (
    EXTRACT(YEAR FROM g.date_received)::int
    + CASE WHEN EXTRACT(MONTH FROM g.date_received)::int >= 7 THEN 1 ELSE 0 END
  )::text,
  m.entity_id,
  m.regional_axis::restriction_axis,
  m.usage_axis::restriction_axis,
  m.time_axis::restriction_axis,
  m.region_ids,
  m.school_recipient_id,
  true,
  now(), now()
FROM (
  VALUES
    -- ── A. Black Wildflowers Fund — usage axis donor_restricted (9) ──────────
    ('NDZdjrr2GEli69zVChgj4', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL::text[], NULL::text), -- $5,000 Education Leaders of Color
    ('HNMMrJwSRe2PO5ysC_8bG', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $480 William Penn Foundation (QB said Foundation-unrestricted; owner: BWF, restricted)
    ('CQCTOUS6l-g85uTYdidxx', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $150 Alexander Brown 2026-04-10
    ('eUBk8zWoVto1XYBEqosYN', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $150 Alexander Brown 2026-05-08
    ('O19isipf8UIhokCX94iCu', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $150 Alexander Brown 2026-05-12
    ('mbSHFb156cyePkgdEJchx', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $150 Alexander Brown 2026-06-08
    ('N-TfE_nUzIsCLcaXuDfyC', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $104.70 Erica Cantoni 2026-06-18
    ('T2Bl-PstVN5e49wEjq2a2', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $17.80 Erica Cantoni 2025-11-17
    ('ivGb5OT41MLN8qUdATa9n', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $50 LaTania Scott 2026-03-25 (donor fixed in step 2)

    -- ── B. Wildflower Foundation — regional axis donor_restricted, region set (4) ──
    ('5H1YAARiAhP6PrHPZU3lV', 'wildflower_foundation', 'donor_restricted', 'unrestricted', 'unrestricted', ARRAY['united_states__puerto_rico']::text[],  NULL), -- $30,000 Banco Popular / Fundación Banco Popular → PR
    ('HuUdtQ2ll6fKPjhO8TwCo', 'wildflower_foundation', 'donor_restricted', 'unrestricted', 'unrestricted', ARRAY['united_states__minnesota']::text[],    NULL), -- $20,000 Sauer Family Foundation → MN
    ('zOej0Fb5thKhbxQ72zQHO', 'wildflower_foundation', 'donor_restricted', 'unrestricted', 'unrestricted', ARRAY['united_states__pennsylvania']::text[], NULL), -- $5,000 Scholler Foundation → PA
    ('h6aekQnUjy9OuiiC3d03z', 'wildflower_foundation', 'donor_restricted', 'unrestricted', 'unrestricted', ARRAY['united_states__california']::text[],   NULL), -- $184 Alia Peera → CA (counts toward goal; flagged for research in step 3)

    -- ── C. Wildflower Foundation — designated to a specific school (2) ────────
    ('9p02rTbfjEkt16Sl9zpTh', 'wildflower_foundation', 'donor_restricted', 'unrestricted', 'unrestricted', ARRAY['united_states__colorado']::text[], 'rec4k51mmfjrlBfEM'), -- $50,000 Ardinger Brown Family Fund → Grand Valley Charter (CO), regional restricted
    ('SY7CFs0-fAU2hIVyUpdEs', 'wildflower_foundation', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, 'recigTQqe0ppRlzcz'),                                     -- $16,000 J. F Maddox Foundation → Marigold Montessori, usage restricted

    -- ── D. Wildflower Foundation — all axes unrestricted (17) ────────────────
    ('YQp3QlLlS21XkpXOVYIyi', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $500 Matt and Katie Kramer (household)
    ('otOMD0WnfRUDFSEUpzjVt', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $40 Betsy Symanietz
    ('ZW8lnri0VjT8Bwhe6EYQJ', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $6.45 Daniela Vasan
    ('qbas_UGB5SraZ624c_aZqt0JcL', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $40.54 Amazon Smile 2021-02-22
    ('qbas_bJxnAvEgXpJn7E8YjLjhi', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $23.47 Amazon Smile 2020-05-22 (QB "Other Revenue" was wrong; owner: normal unrestricted)
    ('qbas_kWl1HckYWYg_Pdz8I8x1Q', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $21.88 Amazon Smile 2022-03-03
    ('qbas_pxCu3QlNBdmlC-S2ltoa5', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $17.58 Amazon Smile 2023-05-22
    ('qbas_Ne0LFzjH0GPpCDaqi7T6o', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $14.65 Amazon Smile 2023-02-13
    ('qbas_4Bntuqkg0MOTA6vp7dC7k', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $13.91 Amazon Smile 2021-08-16
    ('qbas_AOgoZStpjFlzqmxTZDY-R', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $13.72 Amazon Smile 2021-05-25
    ('qbas_RioxxfvidDeVO8AA48ccI', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $13.29 Amazon Smile 2021-11-22
    ('qbas_qqbY2IkVjONBPJKKPY7m-', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $12.88 Amazon Smile 2020-11-12
    ('qbas_Z2ukNeoxE-thZ_DNY5-z-', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $11.36 Amazon Smile 2022-09-02
    ('qbas_jVwrc7wJZrvRoppWCagOt', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $10.04 Amazon Smile 2022-11-21
    ('qbas_UkLKAoS9tdl5eT526zzv1', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $8.75 Amazon Smile 2022-05-31
    ('qbas_noxLWe2OFLp52F9jVEmZI', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL), -- $7.57 Amazon Smile 2023-05-04
    ('qbas_l856Y7VI3iGKMAae6z-cu', 'wildflower_foundation', 'unrestricted', 'unrestricted', 'unrestricted', NULL, NULL)  -- $6.36 Amazon Smile 2020-08-13
) AS m(gift_id, entity_id, regional_axis, usage_axis, time_axis, region_ids, school_recipient_id)
JOIN gifts_and_payments g ON g.id = m.gift_id
WHERE g.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g.id);

-- ══════════════════════════════════════════════════════════════════════════
-- Step 2: fix the LaTania Scott $50 gift donor.
--
-- The gift (ivGb5OT41MLN8qUdATa9n) points at an empty placeholder person
-- (5P8Z3pGo-0bxZege5U7ME). Its linked Stripe charge (ch_3TDwClAhXr9x8yiR0oquIFPK)
-- maps 1:1 to Donorbox donation 65426035: "LaTania Scott",
-- scott.latania7@gmail.com. Populate the placeholder's name (guarded so a later
-- human edit/merge is never clobbered) and attach the email (guarded on the
-- global lower(email) uniqueness so it never aborts if the address already
-- exists somewhere). If the owner later finds an existing LaTania record, merge
-- into it instead.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE people
   SET first_name = 'LaTania',
       last_name  = 'Scott',
       full_name  = 'LaTania Scott',
       updated_at = now()
 WHERE id = '5P8Z3pGo-0bxZege5U7ME'
   AND first_name IS NULL
   AND last_name IS NULL;

INSERT INTO emails (id, email, person_id, validity, is_preferred, created_at, updated_at)
SELECT 'em_0085_latania_scott', 'scott.latania7@gmail.com', '5P8Z3pGo-0bxZege5U7ME',
       'unknown', true, now(), now()
 WHERE EXISTS (SELECT 1 FROM people WHERE id = '5P8Z3pGo-0bxZege5U7ME')
   AND NOT EXISTS (
     SELECT 1 FROM emails WHERE lower(email) = lower('scott.latania7@gmail.com')
   );

-- ══════════════════════════════════════════════════════════════════════════
-- Step 3: flag the Alia Peera $184 gift for research.
--
-- Booked above as a CA-restricted Foundation gift that counts toward goal, but
-- QB shows only a bare "Payment" to Other Revenue in the CA hub with no memo, so
-- a human should confirm whether it is a real donation or a reimbursement
-- correction. Deterministic id ('cleanup_nr_' || target_id) + natural-key
-- conflict, matching the existing convention, so an item a human has already
-- resolved/dismissed is never resurrected.
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO cleanup_queue (
  id, target_type, target_id, reason_code, note, status, flagged_at, created_at, updated_at
)
VALUES (
  'cleanup_nr_h6aekQnUjy9OuiiC3d03z',
  'gift',
  'h6aekQnUjy9OuiiC3d03z',
  'needs_research',
  'Booked as a $184 California-restricted Foundation gift (counts toward goal), but QuickBooks shows only a bare "Payment" to Other Revenue in the CA hub with no memo. Confirm whether this is a real donation or a reimbursement correction.',
  'open',
  now(), now(), now()
)
ON CONFLICT (target_type, target_id, reason_code) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════
-- Post-state verification (verify by STATE, not clean exit).
-- ══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n_orphans        int;  -- active gifts still with zero allocations (expect 0)
  n_seeded         int;  -- allocations created by this file
  n_bwf            int;  -- of those, Black Wildflowers Fund
  n_wf             int;  -- of those, Wildflower Foundation
  latania_ok       int;  -- LaTania person now named
  latania_email    int;  -- LaTania email attached
  alia_flagged     int;  -- Alia research item present
BEGIN
  SELECT count(*) INTO n_orphans
    FROM gifts_and_payments g
   WHERE g.archived_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g.id);

  SELECT count(*) INTO n_seeded  FROM gift_allocations WHERE id LIKE 'ga_0085_%';
  SELECT count(*) INTO n_bwf     FROM gift_allocations WHERE id LIKE 'ga_0085_%' AND entity_id = 'black_wildflowers_fund';
  SELECT count(*) INTO n_wf      FROM gift_allocations WHERE id LIKE 'ga_0085_%' AND entity_id = 'wildflower_foundation';

  SELECT count(*) INTO latania_ok
    FROM people WHERE id = '5P8Z3pGo-0bxZege5U7ME' AND full_name = 'LaTania Scott';
  SELECT count(*) INTO latania_email
    FROM emails WHERE person_id = '5P8Z3pGo-0bxZege5U7ME'
      AND lower(email) = lower('scott.latania7@gmail.com');
  SELECT count(*) INTO alia_flagged
    FROM cleanup_queue WHERE id = 'cleanup_nr_h6aekQnUjy9OuiiC3d03z' AND status = 'open';

  RAISE NOTICE '0085 RESULT: orphan gifts remaining = % (expect 0) | allocations seeded = % (expect 32) | BWF = % (expect 9) | Foundation = % (expect 23) | LaTania named = % (expect 1) | LaTania email = % (expect 1) | Alia flagged = % (expect 1)',
    n_orphans, n_seeded, n_bwf, n_wf, latania_ok, latania_email, alia_flagged;

  IF n_orphans <> 0 THEN
    RAISE WARNING '0085: expected 0 active gifts with zero allocations, found % — investigate before considering this applied', n_orphans;
  END IF;
END $$;
