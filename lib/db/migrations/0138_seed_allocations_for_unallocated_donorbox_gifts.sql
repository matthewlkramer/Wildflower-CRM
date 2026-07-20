-- Seed a single allocation for every Donorbox-backed gift that currently
-- has no gift_allocations rows.  Uses the same campaign→allocation mapping
-- as migrations 0134 and 0135.
--
-- Allocation rules by campaign:
--
--   Wildflower Schools                         → wildflower_foundation, all unrestricted
--   Invest in the Next Generation of Black     → black_wildflowers_fund, all unrestricted
--     Educators!
--   Seeding the Black Wildflowers Fund!        → black_wildflowers_fund, all unrestricted
--   Hurricane Relief for Wildflower Puerto Rico→ wildflower_foundation,
--                                                regional=donor_restricted, region=PR,
--                                                purpose_verbatim='Hurricane Relief'
--   Support Wildflower Minnesota Schools +     → wildflower_foundation,
--     Families                                   fundable_project=mn_immigration_family_support,
--                                                regional=donor_restricted, region=MN
--   Wildflower Schools - DC                    → wildflower_foundation,
--                                                regional=donor_restricted, region=DC
--   Wildflower Schools - NJ                    → wildflower_foundation,
--                                                regional=donor_restricted, region=NJ
--   Growing Wildflowers in the Mid-Atlantic    → wildflower_foundation,
--                                                regional=donor_restricted, regions=PA+NJ
--   Tierra Indígena Montessori                 → tierra_indigena, all unrestricted
--   Wildflower Medical Masks Project           → wildflower_foundation,
--                                                fundable_project=medical_masks,
--                                                intended_usage=project, all unrestricted
--   Wildflower Pollinator Fund                 → wildflower_foundation,
--                                                intended_usage=school_startup,
--                                                usage=donor_restricted, seed_fund=true
--
-- sub_amount = the gift's full amount (single allocation covers the whole gift).
-- grant_year = derived from date_received (FY ends June 30, so +6 months gives the
--              correct year); NULL if the FY row has been deleted (e.g. fy2036+).
--
-- Idempotent: the deterministic id ('ga-dbx-' || gift_id) plus ON CONFLICT DO NOTHING
-- means a second run skips already-created allocations.  The WHERE NOT EXISTS guard
-- additionally skips any gift that has since received an allocation from another source.
--
-- Gifts whose campaign name is not in the known list above are left untouched.
--
-- Applied with: psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--               -f lib/db/migrations/0138_seed_allocations_for_unallocated_donorbox_gifts.sql

WITH donorbox_campaign AS (
  -- Direct Donorbox path
  SELECT pa.gift_id, dd.campaign_name
  FROM payment_applications pa
  JOIN donorbox_donations dd ON dd.id = pa.donorbox_donation_id
  WHERE pa.link_role    = 'counted'
    AND pa.evidence_source = 'donorbox'
    AND dd.campaign_name IS NOT NULL

  UNION ALL

  -- Stripe-backed Donorbox path
  SELECT pa.gift_id, dd.campaign_name
  FROM payment_applications pa
  JOIN donorbox_donations dd ON dd.stripe_charge_id = pa.stripe_charge_id
  WHERE pa.link_role    = 'counted'
    AND pa.evidence_source = 'stripe'
    AND dd.campaign_name IS NOT NULL
),
gift_campaign AS (
  -- One campaign per gift (both paths should agree; first match wins)
  SELECT DISTINCT ON (gift_id) gift_id, campaign_name
  FROM donorbox_campaign
  ORDER BY gift_id
),
target_gifts AS (
  SELECT
    gc.gift_id,
    gc.campaign_name,
    g.amount,
    g.date_received
  FROM gift_campaign gc
  JOIN gifts_and_payments g ON g.id = gc.gift_id
  WHERE gc.campaign_name IN (
    'Wildflower Schools',
    'Invest in the Next Generation of Black Educators!',
    'Seeding the Black Wildflowers Fund!',
    'Hurricane Relief for Wildflower Puerto Rico',
    'Support Wildflower Minnesota Schools + Families',
    'Wildflower Schools - DC',
    'Wildflower Schools - NJ',
    'Growing Wildflowers in the Mid-Atlantic',
    'Tierra Indígena Montessori',
    'Wildflower Medical Masks Project',
    'Wildflower Pollinator Fund'
  )
  -- Only gifts with no allocations at all
  AND NOT EXISTS (
    SELECT 1 FROM gift_allocations WHERE gift_id = gc.gift_id
  )
  AND g.archived_at IS NULL
)
INSERT INTO gift_allocations (
  id,
  gift_id,
  sub_amount,
  grant_year,
  entity_id,
  fundable_project_id,
  intended_usage,
  regional_restriction_type,
  usage_restriction_type,
  time_restriction_type,
  region_ids,
  seed_fund,
  purpose_verbatim,
  counts_toward_goal
)
SELECT
  'ga-dbx-' || tg.gift_id AS id,
  tg.gift_id,
  tg.amount AS sub_amount,

  -- Grant year: derive from date_received (FY ends June 30).
  -- Adding 6 months maps any date in the fiscal year to the calendar year
  -- that the FY is named for (e.g. 2024-07-01 → 2025-01-01 → fy2025).
  -- Returns NULL when date_received is NULL or the computed FY no longer
  -- exists in fiscal_years (e.g. fy2036+ were removed by migration 0137).
  (
    SELECT fy.id
    FROM fiscal_years fy
    WHERE tg.date_received IS NOT NULL
      AND fy.id = 'fy' || EXTRACT(YEAR FROM (tg.date_received + INTERVAL '6 months'))::int::text
    LIMIT 1
  ) AS grant_year,

  CASE tg.campaign_name
    WHEN 'Wildflower Schools'                                THEN 'wildflower_foundation'
    WHEN 'Invest in the Next Generation of Black Educators!' THEN 'black_wildflowers_fund'
    WHEN 'Seeding the Black Wildflowers Fund!'               THEN 'black_wildflowers_fund'
    WHEN 'Hurricane Relief for Wildflower Puerto Rico'        THEN 'wildflower_foundation'
    WHEN 'Support Wildflower Minnesota Schools + Families'   THEN 'wildflower_foundation'
    WHEN 'Wildflower Schools - DC'                           THEN 'wildflower_foundation'
    WHEN 'Wildflower Schools - NJ'                           THEN 'wildflower_foundation'
    WHEN 'Growing Wildflowers in the Mid-Atlantic'           THEN 'wildflower_foundation'
    WHEN 'Tierra Indígena Montessori'                        THEN 'tierra_indigena'
    WHEN 'Wildflower Medical Masks Project'                  THEN 'wildflower_foundation'
    WHEN 'Wildflower Pollinator Fund'                        THEN 'wildflower_foundation'
  END AS entity_id,

  CASE tg.campaign_name
    WHEN 'Support Wildflower Minnesota Schools + Families'   THEN 'mn_immigration_family_support'
    WHEN 'Wildflower Medical Masks Project'                  THEN 'medical_masks'
    ELSE NULL
  END AS fundable_project_id,

  CASE tg.campaign_name
    WHEN 'Wildflower Medical Masks Project'                  THEN 'project'::intended_usage
    WHEN 'Wildflower Pollinator Fund'                        THEN 'school_startup'::intended_usage
    ELSE NULL
  END AS intended_usage,

  CASE tg.campaign_name
    WHEN 'Hurricane Relief for Wildflower Puerto Rico'        THEN 'donor_restricted'::restriction_axis
    WHEN 'Support Wildflower Minnesota Schools + Families'   THEN 'donor_restricted'::restriction_axis
    WHEN 'Wildflower Schools - DC'                           THEN 'donor_restricted'::restriction_axis
    WHEN 'Wildflower Schools - NJ'                           THEN 'donor_restricted'::restriction_axis
    WHEN 'Growing Wildflowers in the Mid-Atlantic'           THEN 'donor_restricted'::restriction_axis
    ELSE 'unrestricted'::restriction_axis
  END AS regional_restriction_type,

  CASE tg.campaign_name
    WHEN 'Wildflower Pollinator Fund'                        THEN 'donor_restricted'::restriction_axis
    ELSE 'unrestricted'::restriction_axis
  END AS usage_restriction_type,

  'unrestricted'::restriction_axis AS time_restriction_type,

  CASE tg.campaign_name
    WHEN 'Hurricane Relief for Wildflower Puerto Rico'        THEN ARRAY['united_states__puerto_rico']
    WHEN 'Support Wildflower Minnesota Schools + Families'   THEN ARRAY['united_states__minnesota']
    WHEN 'Wildflower Schools - DC'                           THEN ARRAY['united_states__maryland__washington_d_c']
    WHEN 'Wildflower Schools - NJ'                           THEN ARRAY['united_states__new_jersey']
    WHEN 'Growing Wildflowers in the Mid-Atlantic'           THEN ARRAY['united_states__pennsylvania', 'united_states__new_jersey']
    ELSE ARRAY[]::text[]
  END AS region_ids,

  CASE tg.campaign_name
    WHEN 'Wildflower Pollinator Fund'                        THEN true
    ELSE false
  END AS seed_fund,

  CASE tg.campaign_name
    WHEN 'Hurricane Relief for Wildflower Puerto Rico'        THEN 'Hurricane Relief'
    ELSE NULL
  END AS purpose_verbatim,

  true AS counts_toward_goal

FROM target_gifts tg
ON CONFLICT (id) DO NOTHING;
