-- 0238 — Remove demo, import-placeholder, and E2E accounts from owner pickers.
--
-- Archiving is intentionally non-destructive: historical owner/author foreign
-- keys continue to resolve, while GET /api/users (the assignable-owner source)
-- already excludes archived users.
--
-- Apply from the repository root:
-- psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0238_archive_non_owner_accounts.sql

UPDATE users
SET archived_at = NOW(),
    updated_at = NOW()
WHERE archived_at IS NULL
  AND (
    -- Exact demo fixtures from scripts/seed.ts.
    clerk_id IN ('demo_ben', 'demo_carla')
    OR LOWER(email) IN (
      'ben@wildflowerschools.org',
      'carla@wildflowerschools.org',
      'former-copper-user@wildflowerschools.org'
    )
    OR LOWER(COALESCE(display_name, '')) IN (
      'ben reston',
      'carla santos',
      'former copper user'
    )
    -- Canonical E2E identity predicate; keep in sync with
    -- scripts/src/cleanup-test-users.ts and emailIntelAdmin.ts.
    OR (
      first_name ILIKE 'Test'
      AND last_name IN ('Dev', 'Admin')
    )
  );
