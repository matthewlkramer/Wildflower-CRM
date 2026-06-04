-- Migration 0010: Drop the legacy pre-consolidation organizations columns
--
-- Retires three columns left over from the funders→organizations
-- consolidation. They were superseded long ago but never physically dropped,
-- and were only kept declared (as @deprecated) in the Drizzle schema so the
-- interactive post-merge `drizzle-kit push` wouldn't see a data-loss diff and
-- abort. This migration removes them for good:
--
--   active_or_defunct  text                 → superseded by active_status
--   type               organization_type    → superseded by entity_type
--   parent_org_id      text (self-FK)        → superseded by parent_organization_id
--
-- It also drops the now-unused `organization_type` enum (only this column used
-- it) and the column's dependent index (organizations_parent_org_id_idx) +
-- self-FK, which Postgres removes automatically with the column.
--
-- BACKFILL: the only legacy data not already mirrored into the new columns is
-- 3 rows (the synth-org-* seed rows) where active_or_defunct = 'active' but
-- active_status is still NULL — a casing mismatch in the original consolidation
-- (it matched 'Active', the seed used 'active'). We copy those into
-- active_status before dropping. `type` and `parent_org_id` carry NO orphaned
-- data (every populated `type` already has entity_type; parent_org_id is empty
-- in both dev and prod), so they need no backfill.
--
-- SAFETY: a guard block aborts the whole migration if ANY legacy column still
-- holds a value not represented in its replacement, so we can never silently
-- drop live data.
--
-- ORDER: this is a pure data/schema cleanup with no application-code dependency
-- (no code reads these columns). It can ship before or after the matching code
-- change that removes the @deprecated declarations — order does not matter.
--
-- Idempotent: column-existence is checked before backfill/guard, and the drops
-- use IF EXISTS, so a second run is a clean no-op.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0010_drop_legacy_organization_columns.sql

DO $$
DECLARE
  has_aod    boolean;
  has_type   boolean;
  has_parent boolean;
  aod_orphans    int := 0;
  type_orphans   int := 0;
  parent_orphans int := 0;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'organizations' AND column_name = 'active_or_defunct') INTO has_aod;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'organizations' AND column_name = 'type') INTO has_type;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'organizations' AND column_name = 'parent_org_id') INTO has_parent;

  -- Backfill the active_or_defunct → active_status orphans (case-insensitive).
  IF has_aod THEN
    EXECUTE $q$
      UPDATE organizations
      SET active_status = CASE lower(active_or_defunct)
            WHEN 'active'    THEN 'active'::active_status
            WHEN 'defunct'   THEN 'defunct'::active_status
            WHEN 'spenddown' THEN 'spenddown'::active_status
            ELSE active_status
          END
      WHERE active_or_defunct IS NOT NULL
        AND active_status IS NULL
        AND lower(active_or_defunct) IN ('active', 'defunct', 'spenddown')
    $q$;
    EXECUTE 'SELECT count(*) FROM organizations
             WHERE active_or_defunct IS NOT NULL AND active_status IS NULL'
      INTO aod_orphans;
  END IF;

  IF has_type THEN
    EXECUTE 'SELECT count(*) FROM organizations
             WHERE type IS NOT NULL AND entity_type IS NULL'
      INTO type_orphans;
  END IF;

  IF has_parent THEN
    EXECUTE 'SELECT count(*) FROM organizations
             WHERE parent_org_id IS NOT NULL AND parent_organization_id IS NULL'
      INTO parent_orphans;
  END IF;

  IF aod_orphans <> 0 OR type_orphans <> 0 OR parent_orphans <> 0 THEN
    RAISE EXCEPTION
      'Aborting drop: orphaned legacy data remains (active_or_defunct=%, type=%, parent_org_id=%). Investigate before dropping.',
      aod_orphans, type_orphans, parent_orphans;
  END IF;
END $$;

-- Drop the columns (dependent index + self-FK go with parent_org_id automatically).
ALTER TABLE organizations DROP COLUMN IF EXISTS active_or_defunct;
ALTER TABLE organizations DROP COLUMN IF EXISTS type;
ALTER TABLE organizations DROP COLUMN IF EXISTS parent_org_id;

-- The enum is now unused (only organizations.type referenced it).
DROP TYPE IF EXISTS organization_type;

-- Verification (all three should return 0 rows / absent):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'organizations'
--      AND column_name IN ('active_or_defunct', 'type', 'parent_org_id');
--   SELECT 1 FROM pg_type WHERE typname = 'organization_type';
--   SELECT count(*) FILTER (WHERE active_status IS NULL) AS null_active_status FROM organizations;
