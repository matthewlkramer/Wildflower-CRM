-- 0153 — Region groupings split from hierarchy: memberships + aliases (Task: region model)
--
-- Additive + idempotent. Apply with:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0153_region_memberships_and_aliases.sql
-- (No BEGIN/COMMIT here — psql -1 wraps the file in one transaction.)
--
-- 1. region_type gains 'custom_region' (admin-defined business grouping).
-- 2. region_memberships: container INCLUDES member (grouping edges), kept
--    separate from regions.parent_region_id (natural geographic parentage).
-- 3. region_aliases: alternate search names ("NYC", "DC", "Twin Cities").
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction on old PG,
-- but is allowed in PG12+ inside a transaction as long as the new value is
-- not used in the same transaction. This file only adds the value.

ALTER TYPE region_type ADD VALUE IF NOT EXISTS 'custom_region';

CREATE TABLE IF NOT EXISTS region_memberships (
  id text PRIMARY KEY,
  container_region_id text NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  member_region_id text NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT region_memberships_no_self_link CHECK (container_region_id <> member_region_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS region_memberships_container_member_uq
  ON region_memberships (container_region_id, member_region_id);
CREATE INDEX IF NOT EXISTS region_memberships_member_region_id_idx
  ON region_memberships (member_region_id);

CREATE TABLE IF NOT EXISTS region_aliases (
  id text PRIMARY KEY,
  region_id text NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  alias text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS region_aliases_region_alias_uq
  ON region_aliases (region_id, lower(alias));
CREATE INDEX IF NOT EXISTS region_aliases_alias_idx
  ON region_aliases (lower(alias));
