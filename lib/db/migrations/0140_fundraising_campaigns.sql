-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0140: Fundraising campaigns table + gifts FK
-- ─────────────────────────────────────────────────────────────────────────────
-- Runbook:
--   1. Ensure schema code (fundraisingCampaigns.ts + campaignSlug column) is
--      Published (deployed) BEFORE running this file so the FK target table
--      exists in prod before gifts_and_payments references it.
--   2. Apply:
--        psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--          -f lib/db/migrations/0140_fundraising_campaigns.sql
--   3. This file is idempotent — safe to re-run.
--   4. Do NOT wrap in BEGIN/COMMIT; psql -1 provides the outer transaction.
-- ─────────────────────────────────────────────────────────────────────────────

-- Step 1: Create the fundraising_campaigns table (idempotent).
CREATE TABLE IF NOT EXISTS fundraising_campaigns (
  slug                        text PRIMARY KEY,
  name                        text NOT NULL,
  donorbox_campaign_id        text,
  email_sent_at               timestamp,
  entity_id                   text REFERENCES entities(id) ON DELETE SET NULL,
  regional_restriction        restriction_axis,
  usage_restriction           restriction_axis,
  time_restriction            restriction_axis,
  regional_restriction_detail text,
  usage_restriction_detail    text,
  time_restriction_detail     text,
  archived_at                 timestamp,
  created_at                  timestamp NOT NULL DEFAULT now(),
  updated_at                  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fundraising_campaigns_donorbox_campaign_id_idx
  ON fundraising_campaigns (donorbox_campaign_id);

CREATE INDEX IF NOT EXISTS fundraising_campaigns_entity_id_idx
  ON fundraising_campaigns (entity_id);

CREATE INDEX IF NOT EXISTS fundraising_campaigns_archived_at_idx
  ON fundraising_campaigns (archived_at);

-- Step 2: Add campaign_slug FK column to gifts_and_payments (idempotent).
ALTER TABLE gifts_and_payments
  ADD COLUMN IF NOT EXISTS campaign_slug text
    REFERENCES fundraising_campaigns(slug)
    ON DELETE SET NULL
    ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS gifts_and_payments_campaign_slug_idx
  ON gifts_and_payments (campaign_slug);

-- Step 3: Seed fundraising_campaigns — one row per distinct (campaign_name, campaign_id) pair.
-- Slug derivation: lowercase → strip non-alphanumeric/space → collapse whitespace
-- → replace spaces with hyphens → truncate to 80 chars.
-- Collision handling: if two pairs normalize to the same base slug, the later
-- ones (ordered by campaign_id) get a disambiguating '-<campaign_id>' suffix
-- so every pair inserts exactly once.
-- ON CONFLICT DO NOTHING keeps re-runs idempotent.
WITH campaign_pairs AS (
  -- One row per distinct (campaign_name, campaign_id) pair with a non-empty name.
  SELECT DISTINCT
    d.campaign_name,
    d.campaign_id
  FROM donorbox_donations d
  WHERE d.campaign_name IS NOT NULL
    AND d.campaign_name <> ''
    AND d.campaign_id   IS NOT NULL
),
with_base_slug AS (
  SELECT
    campaign_name,
    campaign_id,
    SUBSTRING(
      REGEXP_REPLACE(
        REGEXP_REPLACE(
          REGEXP_REPLACE(LOWER(campaign_name), '[^a-z0-9 ]', '', 'g'),
          '\s+', ' ', 'g'
        ),
        ' ', '-', 'g'
      ),
      1, 80
    ) AS base_slug
  FROM campaign_pairs
),
with_rank AS (
  -- Number each pair within a base_slug partition (ordered deterministically by
  -- campaign_id). rn=1 keeps the base slug; rn>1 appends '-<campaign_id>'.
  SELECT
    campaign_name,
    campaign_id,
    base_slug,
    ROW_NUMBER() OVER (PARTITION BY base_slug ORDER BY campaign_id) AS rn
  FROM with_base_slug
  WHERE base_slug <> ''
),
final_slugs AS (
  SELECT
    campaign_name,
    campaign_id,
    CASE
      WHEN rn = 1 THEN SUBSTRING(base_slug, 1, 80)
      ELSE SUBSTRING(SUBSTRING(base_slug, 1, 73) || '-' || campaign_id, 1, 80)
    END AS slug
  FROM with_rank
)
INSERT INTO fundraising_campaigns (slug, name, donorbox_campaign_id, created_at, updated_at)
SELECT slug, campaign_name AS name, campaign_id AS donorbox_campaign_id, now(), now()
FROM final_slugs
ON CONFLICT (slug) DO NOTHING;

-- Step 4a: Backfill gifts_and_payments.campaign_slug for non-Stripe Donorbox gifts.
-- Path: gift → payment_applications (counted, evidence_source='donorbox') →
--   donorbox_donations (via donorbox_donation_id) → fundraising_campaigns.
-- Only fills NULL campaign_slug rows.
UPDATE gifts_and_payments g
SET    campaign_slug = fc.slug,
       updated_at    = now()
FROM   payment_applications pa
JOIN   donorbox_donations dd
       ON dd.id = pa.donorbox_donation_id
JOIN   fundraising_campaigns fc
       ON fc.donorbox_campaign_id = dd.campaign_id
WHERE  pa.evidence_source = 'donorbox'
  AND  pa.link_role = 'counted'
  AND  pa.gift_id = g.id
  AND  g.campaign_slug IS NULL
  AND  dd.campaign_id IS NOT NULL;

-- Step 4a-stripe: Backfill gifts backed by Stripe-type Donorbox donations.
-- Donorbox donations with donation_type='stripe' enrich a Stripe-sourced gift:
--   the payment_applications row uses evidence_source='stripe' and the join to
--   the Donorbox campaign data goes through donorbox_donations.stripe_charge_id.
-- Path: gift → payment_applications (counted, evidence_source='stripe') →
--   donorbox_donations (stripe_charge_id = pa.stripe_charge_id) →
--   fundraising_campaigns (donorbox_campaign_id = dd.campaign_id).
-- Only fills NULL campaign_slug rows.
UPDATE gifts_and_payments g
SET    campaign_slug = fc.slug,
       updated_at    = now()
FROM   payment_applications pa
JOIN   donorbox_donations dd
       ON dd.stripe_charge_id = pa.stripe_charge_id
JOIN   fundraising_campaigns fc
       ON fc.donorbox_campaign_id = dd.campaign_id
WHERE  pa.evidence_source = 'stripe'
  AND  pa.link_role = 'counted'
  AND  pa.stripe_charge_id IS NOT NULL
  AND  pa.gift_id = g.id
  AND  g.campaign_slug IS NULL
  AND  dd.campaign_id IS NOT NULL;

-- Step 4b: Backfill via plain-text fundraising_campaign → slug normalization.
-- Applies to gifts not already filled by 4a that have a non-empty
-- fundraising_campaign string which normalizes to a known campaign slug.
-- Same derivation as the INSERT above.
UPDATE gifts_and_payments g
SET    campaign_slug = SUBSTRING(
                         REGEXP_REPLACE(
                           REGEXP_REPLACE(
                             REGEXP_REPLACE(LOWER(g.fundraising_campaign), '[^a-z0-9 ]', '', 'g'),
                             '\s+', ' ', 'g'
                           ),
                           ' ', '-', 'g'
                         ),
                         1, 80
                       ),
       updated_at    = now()
FROM   fundraising_campaigns fc
WHERE  g.campaign_slug IS NULL
  AND  g.fundraising_campaign IS NOT NULL
  AND  g.fundraising_campaign <> ''
  AND  fc.slug = SUBSTRING(
                   REGEXP_REPLACE(
                     REGEXP_REPLACE(
                       REGEXP_REPLACE(LOWER(g.fundraising_campaign), '[^a-z0-9 ]', '', 'g'),
                       '\s+', ' ', 'g'
                     ),
                     ' ', '-', 'g'
                   ),
                   1, 80
                 );
