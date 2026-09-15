-- 0257: Add stable Flodesk MCP campaign identity and engagement-sync watermarks.
-- Safe and idempotent: nullable metadata/counter columns only; no existing evidence changes.
-- Apply from the repository root with:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0257_flodesk_mcp_engagement_sync.sql

ALTER TABLE newsletter_campaigns
  ADD COLUMN IF NOT EXISTS provider_campaign_id text,
  ADD COLUMN IF NOT EXISTS last_engagement_synced_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS newsletter_campaigns_provider_id_uq
  ON newsletter_campaigns(provider_campaign_id)
  WHERE provider_campaign_id IS NOT NULL;

ALTER TABLE flodesk_sync_state
  ADD COLUMN IF NOT EXISTS campaigns_checked integer,
  ADD COLUMN IF NOT EXISTS campaigns_refreshed integer,
  ADD COLUMN IF NOT EXISTS engagement_records_upserted integer;
