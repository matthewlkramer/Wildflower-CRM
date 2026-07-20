-- Backfill gift_allocations for Donorbox-linked gifts based on campaign name.
--
-- Four campaign groups:
--   1. "Wildflower Schools"                          → wildflower_foundation, all unrestricted, no regions
--   2. "Invest in the Next Generation of Black Educators!"
--      "Seeding the Black Wildflowers Fund!"         → black_wildflowers_fund, all unrestricted, no regions
--   3. "Hurricane Relief for Wildflower Puerto Rico" → wildflower_foundation + hurricane_relief project,
--                                                       region=PR, regional=donor_restricted
--   4. "Support Wildflower Minnesota Schools + Families" → mn_immigration_family_support project,
--                                                           region=MN, regional=donor_restricted
--
-- Idempotent: safe to re-run. Seeds any missing fundable_projects rows first,
-- then updates gift_allocations.
-- Applied with: psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--               -f lib/db/migrations/0134_backfill_donorbox_campaign_allocations.sql

-- Ensure referenced fundable_projects rows exist (prod may not have them yet).
INSERT INTO fundable_projects (id, name) VALUES
  ('hurricane_relief',          'Hurricane Relief for Wildflower Puerto Rico'),
  ('mn_immigration_family_support', 'Support for MN families - 2026')
ON CONFLICT (id) DO NOTHING;

WITH donorbox_campaign AS (
  -- Direct donorbox path (evidence_source = 'donorbox', donorbox_donation_id anchor)
  SELECT pa.gift_id, dd.campaign_name
  FROM payment_applications pa
  JOIN donorbox_donations dd ON dd.id = pa.donorbox_donation_id
  WHERE pa.link_role = 'counted'
    AND pa.evidence_source = 'donorbox'
    AND dd.campaign_name IS NOT NULL

  UNION ALL

  -- Stripe-backed donorbox path (evidence_source = 'stripe', donorbox behind stripe charge)
  SELECT pa.gift_id, dd.campaign_name
  FROM payment_applications pa
  JOIN donorbox_donations dd ON dd.stripe_charge_id = pa.stripe_charge_id
  WHERE pa.link_role = 'counted'
    AND pa.evidence_source = 'stripe'
    AND dd.campaign_name IS NOT NULL
),
gift_campaign AS (
  -- One campaign per gift (first match wins; both paths should agree)
  SELECT DISTINCT ON (gift_id) gift_id, campaign_name
  FROM donorbox_campaign
  ORDER BY gift_id
),
target_gifts AS (
  SELECT gift_id, campaign_name
  FROM gift_campaign
  WHERE campaign_name IN (
    'Wildflower Schools',
    'Invest in the Next Generation of Black Educators!',
    'Seeding the Black Wildflowers Fund!',
    'Hurricane Relief for Wildflower Puerto Rico',
    'Support Wildflower Minnesota Schools + Families'
  )
)
UPDATE gift_allocations ga
SET
  entity_id = CASE gc.campaign_name
    WHEN 'Wildflower Schools'                                  THEN 'wildflower_foundation'
    WHEN 'Invest in the Next Generation of Black Educators!'   THEN 'black_wildflowers_fund'
    WHEN 'Seeding the Black Wildflowers Fund!'                 THEN 'black_wildflowers_fund'
    WHEN 'Hurricane Relief for Wildflower Puerto Rico'         THEN 'wildflower_foundation'
    ELSE ga.entity_id   -- MN families: leave entity unchanged
  END,
  fundable_project_id = CASE gc.campaign_name
    WHEN 'Hurricane Relief for Wildflower Puerto Rico'            THEN 'hurricane_relief'
    WHEN 'Support Wildflower Minnesota Schools + Families'        THEN 'mn_immigration_family_support'
    ELSE NULL
  END,
  regional_restriction_type = CASE gc.campaign_name
    WHEN 'Hurricane Relief for Wildflower Puerto Rico'            THEN 'donor_restricted'::restriction_axis
    WHEN 'Support Wildflower Minnesota Schools + Families'        THEN 'donor_restricted'::restriction_axis
    ELSE 'unrestricted'::restriction_axis
  END,
  usage_restriction_type    = 'unrestricted'::restriction_axis,
  time_restriction_type     = 'unrestricted'::restriction_axis,
  region_ids = CASE gc.campaign_name
    WHEN 'Hurricane Relief for Wildflower Puerto Rico'            THEN ARRAY['united_states__puerto_rico']
    WHEN 'Support Wildflower Minnesota Schools + Families'        THEN ARRAY['united_states__minnesota']
    ELSE ARRAY[]::text[]
  END
FROM target_gifts gc
WHERE ga.gift_id = gc.gift_id;
