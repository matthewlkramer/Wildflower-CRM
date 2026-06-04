-- Migration 0008: Admin-configurable internal staff email domains
--
-- Internal staff Google Workspace domains (wildflowerschools.org,
-- blackwildflowers.org) were previously hardcoded in INTERNAL_DOMAINS in
-- artifacts/api-server/src/lib/emailMatcher.ts. They now live in a singleton
-- settings table so admins can add/remove a domain from the Admin screen
-- without a code change + deploy.
--
-- Creates a singleton table (one row, id = 'singleton') holding a text[] of
-- bare lowercase domains. The Gmail + Calendar sync matcher loads this list
-- (short-lived in-memory cache) and drops any address whose domain matches, so
-- internal staff-to-staff threads never land on a donor timeline.
--
-- The seed row carries the original two domains, so behavior is unchanged on
-- rollout. (The application also self-seeds the row on first GET, so this
-- migration mainly guarantees the row exists before the first sync tick runs.)
--
-- ORDER: safe to run before OR after deploying the new application code. The
-- new code falls back to the original two domains when the row is absent, and
-- old code never reads this table.
--
-- Non-destructive + idempotent: CREATE TABLE IF NOT EXISTS + INSERT ...
-- ON CONFLICT DO NOTHING, so a second run is a no-op and no existing data is
-- touched.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0008_internal_email_domains.sql

CREATE TABLE IF NOT EXISTS internal_email_domains (
  id         text PRIMARY KEY DEFAULT 'singleton',
  domains    text[] NOT NULL DEFAULT ARRAY['wildflowerschools.org','blackwildflowers.org']::text[],
  updated_at timestamp NOT NULL DEFAULT now()
);

INSERT INTO internal_email_domains (id, domains)
VALUES ('singleton', ARRAY['wildflowerschools.org','blackwildflowers.org']::text[])
ON CONFLICT (id) DO NOTHING;
