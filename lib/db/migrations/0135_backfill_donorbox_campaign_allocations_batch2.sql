-- Backfill gift_allocations for six more Donorbox campaign groups.
--
--   "Wildflower Schools - DC"                → wildflower_foundation, region=DC, regional=donor_restricted
--   "Wildflower Schools - NJ"                → wildflower_foundation, region=NJ, regional=donor_restricted
--   "Growing Wildflowers in the Mid-Atlantic"→ wildflower_foundation, regions=PA+NJ, regional=donor_restricted
--   "Tierra Indígena Montessori"             → tierra_indigena, all unrestricted, no regions
--   "Wildflower Medical Masks Project"       → wildflower_foundation, project=medical_masks,
--                                              intended_usage=project, all unrestricted
--   "Wildflower Pollinator Fund"             → wildflower_foundation, intended_usage=school_startup,
--                                              usage=donor_restricted, seed_fund=true
--
-- Idempotent: pure UPDATE, safe to re-run.
-- Applied with: psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--               -f lib/db/migrations/0135_backfill_donorbox_campaign_allocations_batch2.sql

WITH donorbox_campaign AS (
  -- Direct donorbox path
  SELECT pa.gift_id, dd.campaign_name
  FROM payment_applications pa
  JOIN donorbox_donations dd ON dd.id = pa.donorbox_donation_id
  WHERE pa.link_role = 'counted'
    AND pa.evidence_source = 'donorbox'
    AND dd.campaign_name IS NOT NULL

  UNION ALL

  -- Stripe-backed donorbox path
  SELECT pa.gift_id, dd.campaign_name
  FROM payment_applications pa
  JOIN donorbox_donations dd ON dd.stripe_charge_id = pa.stripe_charge_id
  WHERE pa.link_role = 'counted'
    AND pa.evidence_source = 'stripe'
    AND dd.campaign_name IS NOT NULL
),
gift_campaign AS (
  SELECT DISTINCT ON (gift_id) gift_id, campaign_name
  FROM donorbox_campaign
  ORDER BY gift_id
),
target_gifts AS (
  SELECT gift_id, campaign_name
  FROM gift_campaign
  WHERE campaign_name IN (
    'Wildflower Schools - DC',
    'Wildflower Schools - NJ',
    'Growing Wildflowers in the Mid-Atlantic',
    'Tierra Indígena Montessori',
    'Wildflower Medical Masks Project',
    'Wildflower Pollinator Fund'
  )
)
UPDATE gift_allocations ga
SET
  entity_id = CASE gc.campaign_name
    WHEN 'Wildflower Schools - DC'                    THEN 'wildflower_foundation'
    WHEN 'Wildflower Schools - NJ'                    THEN 'wildflower_foundation'
    WHEN 'Growing Wildflowers in the Mid-Atlantic'    THEN 'wildflower_foundation'
    WHEN 'Tierra Indígena Montessori'                 THEN 'tierra_indigena'
    WHEN 'Wildflower Medical Masks Project'           THEN 'wildflower_foundation'
    WHEN 'Wildflower Pollinator Fund'                 THEN 'wildflower_foundation'
  END,
  fundable_project_id = CASE gc.campaign_name
    WHEN 'Wildflower Medical Masks Project'           THEN 'medical_masks'
    ELSE NULL
  END,
  intended_usage = CASE gc.campaign_name
    WHEN 'Wildflower Medical Masks Project'           THEN 'project'::intended_usage
    WHEN 'Wildflower Pollinator Fund'                 THEN 'school_startup'::intended_usage
    ELSE ga.intended_usage
  END,
  regional_restriction_type = CASE gc.campaign_name
    WHEN 'Wildflower Schools - DC'                    THEN 'donor_restricted'::restriction_axis
    WHEN 'Wildflower Schools - NJ'                    THEN 'donor_restricted'::restriction_axis
    WHEN 'Growing Wildflowers in the Mid-Atlantic'    THEN 'donor_restricted'::restriction_axis
    ELSE 'unrestricted'::restriction_axis
  END,
  usage_restriction_type = CASE gc.campaign_name
    WHEN 'Wildflower Pollinator Fund'                 THEN 'donor_restricted'::restriction_axis
    ELSE 'unrestricted'::restriction_axis
  END,
  time_restriction_type     = 'unrestricted'::restriction_axis,
  region_ids = CASE gc.campaign_name
    WHEN 'Wildflower Schools - DC'                    THEN ARRAY['united_states__maryland__washington_d_c']
    WHEN 'Wildflower Schools - NJ'                    THEN ARRAY['united_states__new_jersey']
    WHEN 'Growing Wildflowers in the Mid-Atlantic'    THEN ARRAY['united_states__pennsylvania',
                                                                  'united_states__new_jersey']
    ELSE ARRAY[]::text[]
  END,
  seed_fund = CASE gc.campaign_name
    WHEN 'Wildflower Pollinator Fund'                 THEN true
    ELSE false
  END
FROM target_gifts gc
WHERE ga.gift_id = gc.gift_id;
