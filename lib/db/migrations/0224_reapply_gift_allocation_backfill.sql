-- 0224_reapply_gift_allocation_backfill.sql
--
-- DATA-ONLY production backfill. SUPERSEDES 0085_backfill_gift_allocations.sql,
-- which was written 2026-07-02 but never applied to production (verified:
-- zero 'ga_0085_%' rows exist there). 0085 can no longer run as written:
--   1. Migration 0150 renamed gift_allocations.usage_restriction_type to
--      other_restriction_type, so 0085's INSERT column list now errors.
--   2. cleanup_queue has no unique constraint on (target_type, target_id,
--      reason_code), so 0085's ON CONFLICT clause aborts the transaction.
-- This file re-applies the SAME owner-ratified booking against the current
-- schema. Do not run 0085.
--
-- WHY: every gift must have at least one gift_allocations row — that child row
-- is where ALL money scope lives (fund entity, fiscal year, sub-amount,
-- restriction axes, region, school recipient) and revenue coding is derived
-- from it. The mint-path seeding + backstop guard have shipped as app code, so
-- no NEW orphans can be created; this closes out the historical ones.
--
-- As of 2026-07-31 production has 26 remaining orphans (6 of 0085's 32 were
-- since resolved by hand). The full 32-gift mapping is retained below — the
-- NOT EXISTS guard makes the already-resolved rows a harmless no-op.
--
-- The booking was confirmed with the product owner (see the 0085 runbook) and
-- OVERRIDES the QuickBooks signal wherever they conflict. It is enumerated by
-- gift id and is NOT to be re-derived in code. Note: gift zOej0Fb5thKhbxQ72zQHO
-- has been renamed "Saint Paul & Minnesota Foundation" since 0085 was written,
-- but its donor org is "Scholler Foundation (of Saint Paul & MN Foundation)" —
-- same gift, same ratified PA-restricted booking. The owner is unsure the
-- record is right, so step 3 also flags it needs_research (booking stands
-- until the research says otherwise).
--
--   A. Black Wildflowers Fund — other (usage) axis donor_restricted.
--   B. Wildflower Foundation, geographically restricted — regional axis
--      donor_restricted, region set.
--   C. Wildflower Foundation, designated to a specific school —
--      school_recipient_id set (the established convention: NOT the
--      direct_to_school entity).
--   D. Wildflower Foundation, unrestricted — all three axes unrestricted.
--
-- Every inserted row: sub_amount = the gift amount, grant_year = the Wildflower
-- fiscal year of date_received (FY runs Jul 1 – Jun 30, named by the ending
-- year: month >= 7 -> next calendar year), counts_toward_goal = true. The
-- grant_year is guarded on the fiscal_years row actually existing (matching the
-- app-side seeding), so a missing FY can never trip the FK — verified present
-- in prod for all 26 current orphans (fy2018, fy2020..fy2024, fy2026).
-- display_usage is trigger-maintained — never set directly.
--
-- IDEMPOTENT: each allocation gets a deterministic id ('ga_0224_' || gift_id)
-- and is only inserted WHERE NOT EXISTS an allocation for that gift; the donor
-- name-fix is guarded on the names still being NULL; the email insert on global
-- lower(email) uniqueness; the cleanup item on NOT EXISTS of the natural key.
-- Re-running after a successful apply is a no-op. NON-DESTRUCTIVE: no DELETEs,
-- no overwrites of existing scope.
--
-- Applied by a human (the agent cannot write prod), from the repo root:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0224_reapply_gift_allocation_backfill.sql
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
  RAISE NOTICE '0224: active gifts with ZERO allocations BEFORE = % (expect 26 on first apply, 0 on re-run)', n_orphans;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- Step 1: backfill one allocation per orphan gift (sections A–D).
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO gift_allocations (
  id, gift_id, sub_amount, grant_year, entity_id,
  regional_restriction_type, other_restriction_type, time_restriction_type,
  region_ids, school_recipient_id, counts_toward_goal, created_at, updated_at
)
SELECT
  'ga_0224_' || g.id,
  g.id,
  g.amount,
  fy.id,  -- NULL when the computed fiscal_years row does not exist
  m.entity_id,
  m.regional_axis::restriction_axis,
  m.other_axis::restriction_axis,
  m.time_axis::restriction_axis,
  m.region_ids,
  m.school_recipient_id,
  true,
  now(), now()
FROM (
  VALUES
    -- ── A. Black Wildflowers Fund — other (usage) axis donor_restricted ──────
    ('NDZdjrr2GEli69zVChgj4', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL::text[], NULL::text), -- $5,000 Education Leaders of Color
    ('HNMMrJwSRe2PO5ysC_8bG', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $480 William Penn Foundation (resolved since 0085 — no-op)
    ('CQCTOUS6l-g85uTYdidxx', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $150 Alexander Brown 2026-04-10 (resolved since 0085 — no-op)
    ('eUBk8zWoVto1XYBEqosYN', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $150 Alexander Brown 2026-05-08 (resolved since 0085 — no-op)
    ('O19isipf8UIhokCX94iCu', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $150 Alexander Brown 2026-05-12
    ('mbSHFb156cyePkgdEJchx', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $150 Alexander Brown 2026-06-08 (resolved since 0085 — no-op)
    ('N-TfE_nUzIsCLcaXuDfyC', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $104.70 Erica Cantoni 2026-06-18 (resolved since 0085 — no-op)
    ('T2Bl-PstVN5e49wEjq2a2', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $17.80 Erica Cantoni 2025-11-17
    ('ivGb5OT41MLN8qUdATa9n', 'black_wildflowers_fund', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, NULL),               -- $50 LaTania Scott 2026-03-25 (resolved since 0085 — no-op; donor still fixed in step 2)

    -- ── B. Wildflower Foundation — regional axis donor_restricted, region set ──
    ('5H1YAARiAhP6PrHPZU3lV', 'wildflower_foundation', 'donor_restricted', 'unrestricted', 'unrestricted', ARRAY['united_states__puerto_rico']::text[],  NULL), -- $30,000 Fundación Banco Popular → PR
    ('HuUdtQ2ll6fKPjhO8TwCo', 'wildflower_foundation', 'donor_restricted', 'unrestricted', 'unrestricted', ARRAY['united_states__minnesota']::text[],    NULL), -- $20,000 Sauer Family Foundation → MN
    ('zOej0Fb5thKhbxQ72zQHO', 'wildflower_foundation', 'donor_restricted', 'unrestricted', 'unrestricted', ARRAY['united_states__pennsylvania']::text[], NULL), -- $5,000 Scholler Foundation (of Saint Paul & MN Foundation) → PA (flagged for research in step 3)
    ('h6aekQnUjy9OuiiC3d03z', 'wildflower_foundation', 'donor_restricted', 'unrestricted', 'unrestricted', ARRAY['united_states__california']::text[],   NULL), -- $184 Alia Peera → CA (flagged for research in step 3)

    -- ── C. Wildflower Foundation — designated to a specific school ────────────
    ('9p02rTbfjEkt16Sl9zpTh', 'wildflower_foundation', 'donor_restricted', 'unrestricted', 'unrestricted', ARRAY['united_states__colorado']::text[], 'rec4k51mmfjrlBfEM'), -- $50,000 Ardinger Brown Family Fund → Grand Valley Charter (CO), regional restricted
    ('SY7CFs0-fAU2hIVyUpdEs', 'wildflower_foundation', 'unrestricted', 'donor_restricted', 'unrestricted', NULL, 'recigTQqe0ppRlzcz'),                                     -- $16,000 J. F Maddox Foundation → Marigold Montessori, usage restricted

    -- ── D. Wildflower Foundation — all axes unrestricted ─────────────────────
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
) AS m(gift_id, entity_id, regional_axis, other_axis, time_axis, region_ids, school_recipient_id)
JOIN gifts_and_payments g ON g.id = m.gift_id
LEFT JOIN fiscal_years fy ON fy.id = 'fy' || (
    EXTRACT(YEAR FROM g.date_received)::int
    + CASE WHEN EXTRACT(MONTH FROM g.date_received)::int >= 7 THEN 1 ELSE 0 END
  )::text
WHERE g.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g.id);

-- ══════════════════════════════════════════════════════════════════════════
-- Step 2: fix the LaTania Scott $50 gift donor.
--
-- The person record (5P8Z3pGo-0bxZege5U7ME) still has NULL first/last names
-- (full_name shows the auto-derived 'Latania Scott'). Its linked Stripe charge
-- (ch_3TDwClAhXr9x8yiR0oquIFPK) maps 1:1 to Donorbox donation 65426035:
-- "LaTania Scott", scott.latania7@gmail.com. Populate the names (guarded so a
-- later human edit/merge is never clobbered) and attach the email (guarded on
-- the global lower(email) uniqueness).
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
SELECT 'em_0224_latania_scott', 'scott.latania7@gmail.com', '5P8Z3pGo-0bxZege5U7ME',
       'unknown', true, now(), now()
 WHERE EXISTS (SELECT 1 FROM people WHERE id = '5P8Z3pGo-0bxZege5U7ME')
   AND NOT EXISTS (
     SELECT 1 FROM emails WHERE lower(email) = lower('scott.latania7@gmail.com')
   );

-- ══════════════════════════════════════════════════════════════════════════
-- Step 3: flag two gifts for research.
--
-- 3a. Alia Peera $184: booked above as a CA-restricted Foundation gift that
--     counts toward goal, but QB shows only a bare "Payment" to Other Revenue
--     in the CA hub with no memo, so a human should confirm whether it is a
--     real donation or a reimbursement correction.
-- 3b. Saint Paul & MN / Scholler $5,000 (zOej0Fb5thKhbxQ72zQHO): the gift was
--     renamed "Saint Paul & Minnesota Foundation" but its donor of record is
--     "Scholler Foundation (of Saint Paul & MN Foundation)". The owner does
--     not think the record is right but is unsure what the fix is; the
--     ratified PA-restricted booking is applied above and stands until the
--     research resolves it.
--
-- cleanup_queue has NO unique constraint on the natural key, so the guard is
-- a NOT EXISTS on (target_type, target_id, reason_code) — an item a human has
-- already resolved/dismissed is never resurrected.
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO cleanup_queue (
  id, target_type, target_id, reason_code, note, status, flagged_at, created_at, updated_at
)
SELECT
  'cleanup_nr_h6aekQnUjy9OuiiC3d03z',
  'gift',
  'h6aekQnUjy9OuiiC3d03z',
  'needs_research',
  'Booked as a $184 California-restricted Foundation gift (counts toward goal), but QuickBooks shows only a bare "Payment" to Other Revenue in the CA hub with no memo. Confirm whether this is a real donation or a reimbursement correction.',
  'open',
  now(), now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM cleanup_queue
   WHERE target_type = 'gift'
     AND target_id = 'h6aekQnUjy9OuiiC3d03z'
     AND reason_code = 'needs_research'
);

INSERT INTO cleanup_queue (
  id, target_type, target_id, reason_code, note, status, flagged_at, created_at, updated_at
)
SELECT
  'cleanup_nr_zOej0Fb5thKhbxQ72zQHO',
  'gift',
  'zOej0Fb5thKhbxQ72zQHO',
  'needs_research',
  'Gift is named "Saint Paul & Minnesota Foundation" but the donor of record is "Scholler Foundation (of Saint Paul & MN Foundation)" — the owner does not believe this record is right but is unsure what the fix is. Research the true donor/grantor relationship (was this a Scholler grant administered by Saint Paul & MN Foundation, or the reverse?) and confirm the $5,000 Pennsylvania-restricted booking. The ratified PA booking is applied and stands until resolved.',
  'open',
  now(), now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM cleanup_queue
   WHERE target_type = 'gift'
     AND target_id = 'zOej0Fb5thKhbxQ72zQHO'
     AND reason_code = 'needs_research'
);

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
  alia_flagged     int;  -- Alia research item present (any status)
  scholler_flagged int;  -- Saint Paul & MN / Scholler research item present (any status)
BEGIN
  SELECT count(*) INTO n_orphans
    FROM gifts_and_payments g
   WHERE g.archived_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g.id);

  SELECT count(*) INTO n_seeded  FROM gift_allocations WHERE id LIKE 'ga_0224_%';
  SELECT count(*) INTO n_bwf     FROM gift_allocations WHERE id LIKE 'ga_0224_%' AND entity_id = 'black_wildflowers_fund';
  SELECT count(*) INTO n_wf      FROM gift_allocations WHERE id LIKE 'ga_0224_%' AND entity_id = 'wildflower_foundation';

  SELECT count(*) INTO latania_ok
    FROM people WHERE id = '5P8Z3pGo-0bxZege5U7ME' AND full_name = 'LaTania Scott';
  SELECT count(*) INTO latania_email
    FROM emails WHERE person_id = '5P8Z3pGo-0bxZege5U7ME'
      AND lower(email) = lower('scott.latania7@gmail.com');
  SELECT count(*) INTO alia_flagged
    FROM cleanup_queue
   WHERE target_type = 'gift' AND target_id = 'h6aekQnUjy9OuiiC3d03z'
     AND reason_code = 'needs_research';
  SELECT count(*) INTO scholler_flagged
    FROM cleanup_queue
   WHERE target_type = 'gift' AND target_id = 'zOej0Fb5thKhbxQ72zQHO'
     AND reason_code = 'needs_research';

  RAISE NOTICE '0224 RESULT: orphan gifts remaining = % (expect 0) | allocations seeded = % (expect 26 on first apply) | BWF = % (expect 3) | Foundation = % (expect 23) | LaTania named = % (expect 1) | LaTania email = % (expect 1) | Alia flagged = % (expect 1) | Scholler flagged = % (expect 1)',
    n_orphans, n_seeded, n_bwf, n_wf, latania_ok, latania_email, alia_flagged, scholler_flagged;

  IF n_orphans <> 0 THEN
    RAISE WARNING '0224: expected 0 active gifts with zero allocations, found % — investigate before considering this applied', n_orphans;
  END IF;
END $$;
