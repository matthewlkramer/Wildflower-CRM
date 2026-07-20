# Runbook: 0135 — backfill Donorbox campaign allocations (batch 2)

Companion to 0134. Fills in `gift_allocations` fields for six more Donorbox
campaign groups.

## Pre-flight checks

```sql
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
    'Wildflower Schools - DC',
    'Wildflower Schools - NJ',
    'Growing Wildflowers in the Mid-Atlantic',
    'Tierra Indígena Montessori',
    'Wildflower Medical Masks Project',
    'Wildflower Pollinator Fund'
  )
)
SELECT gc.campaign_name, COUNT(DISTINCT gc.gift_id) as gifts, COUNT(ga.id) as allocations
FROM target_gifts gc
JOIN gift_allocations ga ON ga.gift_id = gc.gift_id
GROUP BY gc.campaign_name
ORDER BY gc.campaign_name;
```

## Apply (run AFTER 0134 if not already applied)

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0135_backfill_donorbox_campaign_allocations_batch2.sql
```

## Post-flight checks

```sql
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
  ga.intended_usage::text,
  ga.regional_restriction_type::text,
  ga.usage_restriction_type::text,
  ga.time_restriction_type::text,
  ga.region_ids,
  ga.seed_fund
FROM gift_campaign gc
JOIN gift_allocations ga ON ga.gift_id = gc.gift_id
WHERE gc.campaign_name IN (
  'Wildflower Schools - DC',
  'Wildflower Schools - NJ',
  'Growing Wildflowers in the Mid-Atlantic',
  'Tierra Indígena Montessori',
  'Wildflower Medical Masks Project',
  'Wildflower Pollinator Fund'
)
LIMIT 30;
```

Expected attribute values:

| Campaign | entity | project | intended_usage | regional | usage | time | region_ids | seed_fund |
|---|---|---|---|---|---|---|---|---|
| Wildflower Schools - DC | wildflower_foundation | NULL | (unchanged) | donor_restricted | unrestricted | unrestricted | {united_states__maryland__washington_d_c} | false |
| Wildflower Schools - NJ | wildflower_foundation | NULL | (unchanged) | donor_restricted | unrestricted | unrestricted | {united_states__new_jersey} | false |
| Growing Wildflowers in the Mid-Atlantic | wildflower_foundation | NULL | (unchanged) | donor_restricted | unrestricted | unrestricted | {united_states__pennsylvania,united_states__new_jersey} | false |
| Tierra Indígena Montessori | tierra_indigena | NULL | (unchanged) | unrestricted | unrestricted | unrestricted | {} | false |
| Wildflower Medical Masks Project | wildflower_foundation | medical_masks | project | unrestricted | unrestricted | unrestricted | {} | false |
| Wildflower Pollinator Fund | wildflower_foundation | NULL | school_startup | unrestricted | donor_restricted | unrestricted | {} | true |

## Notes

- Safe to re-run: pure UPDATE with fixed values, no side-effects.
- Does NOT touch: "Growing Wildflowers in the Northeast!" — not in scope.
- The `display_usage` trigger fires for each updated row and regenerates
  `display_usage` automatically (e.g. Medical Masks → "Medical Masks",
  Pollinator Fund → "School Startup").
- `tierra_indigena` entity must exist in the `entities` table (verified: it does).
- DC region is stored under the Maryland hierarchy:
  id = `united_states__maryland__washington_d_c`, name = "Washington (D.C.)".
