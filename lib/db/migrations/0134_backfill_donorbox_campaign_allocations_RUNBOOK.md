# Runbook: 0134 — backfill Donorbox campaign allocations

Fills in `gift_allocations` fields (entity, project, restrictions, regions) for
gifts backed by Donorbox donations, based on four campaign name patterns.

## Pre-flight checks

```sql
-- How many gift allocations will be touched?
WITH donorbox_campaign AS (
  SELECT pa.gift_id, dd.campaign_name
  FROM payment_applications pa
  JOIN donorbox_donations dd ON dd.id = pa.donorbox_donation_id
  WHERE pa.link_role = 'counted' AND pa.evidence_source = 'donorbox'
    AND dd.campaign_name IS NOT NULL
  UNION ALL
  SELECT pa.gift_id, dd.campaign_name
  FROM payment_applications pa
  JOIN donorbox_donations dd ON dd.stripe_charge_id = pa.stripe_charge_id
  WHERE pa.link_role = 'counted' AND pa.evidence_source = 'stripe'
    AND dd.campaign_name IS NOT NULL
),
gift_campaign AS (
  SELECT DISTINCT ON (gift_id) gift_id, campaign_name FROM donorbox_campaign ORDER BY gift_id
),
target_gifts AS (
  SELECT gift_id, campaign_name FROM gift_campaign
  WHERE campaign_name IN (
    'Wildflower Schools',
    'Invest in the Next Generation of Black Educators!',
    'Seeding the Black Wildflowers Fund!',
    'Hurricane Relief for Wildflower Puerto Rico',
    'Support Wildflower Minnesota Schools + Families'
  )
)
SELECT gc.campaign_name, COUNT(DISTINCT gc.gift_id) as gifts, COUNT(ga.id) as allocations
FROM target_gifts gc
JOIN gift_allocations ga ON ga.gift_id = gc.gift_id
GROUP BY gc.campaign_name
ORDER BY gc.campaign_name;
```

Expected: rows for each of the 5 campaign names (Seeding may be 0 if those gifts
have no payment_applications yet).

## Apply

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0134_backfill_donorbox_campaign_allocations.sql
```

## Post-flight checks

```sql
-- Spot-check: one gift per campaign group
WITH donorbox_campaign AS (
  SELECT pa.gift_id, dd.campaign_name
  FROM payment_applications pa
  JOIN donorbox_donations dd ON dd.id = pa.donorbox_donation_id
  WHERE pa.link_role = 'counted' AND pa.evidence_source = 'donorbox'
    AND dd.campaign_name IS NOT NULL
  UNION ALL
  SELECT pa.gift_id, dd.campaign_name
  FROM payment_applications pa
  JOIN donorbox_donations dd ON dd.stripe_charge_id = pa.stripe_charge_id
  WHERE pa.link_role = 'counted' AND pa.evidence_source = 'stripe'
    AND dd.campaign_name IS NOT NULL
),
gift_campaign AS (
  SELECT DISTINCT ON (gift_id) gift_id, campaign_name FROM donorbox_campaign ORDER BY gift_id
)
SELECT
  gc.campaign_name,
  ga.entity_id,
  ga.fundable_project_id,
  ga.regional_restriction_type::text,
  ga.usage_restriction_type::text,
  ga.time_restriction_type::text,
  ga.region_ids
FROM gift_campaign gc
JOIN gift_allocations ga ON ga.gift_id = gc.gift_id
WHERE gc.campaign_name IN (
  'Wildflower Schools',
  'Invest in the Next Generation of Black Educators!',
  'Hurricane Relief for Wildflower Puerto Rico',
  'Support Wildflower Minnesota Schools + Families'
)
LIMIT 20;
```

Expected attribute values:

| Campaign | entity_id | fundable_project_id | regional | usage | time | region_ids |
|---|---|---|---|---|---|---|
| Wildflower Schools | wildflower_foundation | NULL | unrestricted | unrestricted | unrestricted | {} |
| Invest in the Next Generation… | black_wildflowers_fund | NULL | unrestricted | unrestricted | unrestricted | {} |
| Hurricane Relief for Wildflower Puerto Rico | wildflower_foundation | hurricane_relief | donor_restricted | unrestricted | unrestricted | {united_states__puerto_rico} |
| Support Wildflower Minnesota Schools + Families | (unchanged) | mn_immigration_family_support | donor_restricted | unrestricted | unrestricted | {united_states__minnesota} |

## Notes

- Safe to re-run: pure UPDATE with fixed values, no side-effects.
- Does NOT touch: Wildflower Schools - DC, Wildflower Schools - NJ, Tierra Indígena,
  Growing Wildflowers Mid-Atlantic/Northeast, Medical Masks, Pollinator Fund — those
  campaigns were not in scope.
- The `display_usage` trigger on `gift_allocations` will fire for each updated row and
  regenerate the gift's `display_usage` field automatically.
- MN families entity_id is left unchanged (not specified in requirements).
