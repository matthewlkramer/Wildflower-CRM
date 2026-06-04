# Runbook — 0010 drop legacy organizations columns

## What this delivers

Permanently removes three pre-consolidation columns from `organizations` that
were superseded during the funders→organizations merge but never physically
dropped:

| Dropped column      | Type                | Replaced by             |
| ------------------- | ------------------- | ----------------------- |
| `active_or_defunct` | `text`              | `active_status`         |
| `type`              | `organization_type` | `entity_type`           |
| `parent_org_id`     | `text` (self-FK)    | `parent_organization_id`|

It also drops the now-unused `organization_type` enum and the
`organizations_parent_org_id_idx` index (+ the self-FK), which Postgres removes
automatically with the column.

These columns were only kept declared (as `@deprecated`) in the Drizzle schema so
the interactive post-merge `drizzle-kit push` wouldn't see a data-loss diff and
abort. This migration retires them, and the matching code change removes the
deprecated declarations.

- Schema: `lib/db/src/schema/organizations.ts` (3 columns + index removed),
  `lib/db/src/schema/_enums.ts` (`organizationTypeEnum` removed)
- Seed: `lib/db/src/post-import-fixups.sql` (synth-org inserts updated to use
  `entity_type` / `active_status`)

## Backfill (the only live data touched)

The single piece of legacy data not already mirrored into the new columns is
**3 rows** (the `synth-org-*` seed rows) where `active_or_defunct = 'active'` but
`active_status` is still NULL — a casing mismatch in the original consolidation
(it matched `'Active'`, the seed used lowercase `'active'`). The migration copies
those into `active_status` (case-insensitively) before dropping.

`type` and `parent_org_id` carry **no** orphaned data: every populated `type`
already has an `entity_type`, and `parent_org_id` is empty in both dev and prod.

A guard block aborts the entire migration if ANY legacy column still holds a value
not represented in its replacement — so live data can never be silently dropped.

## Order of operations

No application code reads these columns, so order does not matter — the migration
can be applied before or after the code change ships. Recommended: apply to prod
around the same time as the Publish that removes the deprecated declarations.

## Preflight (production, optional but recommended)

Run this read-only query first to confirm the expected orphan counts. The
backfillable case (active) should be `3`; `type` and `parent` should be `0`. If
`type` or `parent` are non-zero, STOP and investigate — the migration's guard
would abort rather than drop, but it's better to know before applying:

```sql
SELECT
  count(*) FILTER (WHERE active_or_defunct IS NOT NULL AND active_status IS NULL)            AS active_to_backfill,
  count(*) FILTER (WHERE type IS NOT NULL AND entity_type IS NULL)                           AS type_orphans,
  count(*) FILTER (WHERE parent_org_id IS NOT NULL AND parent_organization_id IS NULL)       AS parent_orphans
FROM organizations;   -- expected: 3, 0, 0
```

## Apply (production)

The agent cannot write to prod, and prod holds live data. A human applies:

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0010_drop_legacy_organization_columns.sql
```

Idempotent: column existence is checked before the backfill/guard, and the drops
use `IF EXISTS` / `DROP TYPE IF EXISTS`, so a second run is a clean no-op.

## Verify

```sql
-- All three columns should be gone:
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'organizations'
   AND column_name IN ('active_or_defunct', 'type', 'parent_org_id');   -- 0 rows

-- The enum should be gone:
SELECT 1 FROM pg_type WHERE typname = 'organization_type';              -- 0 rows

-- No org should have lost its active status to the backfill:
SELECT count(*) AS synth_orgs_active
  FROM organizations
 WHERE id LIKE 'synth-org-%' AND active_status = 'active';              -- 3
```

## Dev note

Dev had this migration applied with the same idempotent SQL above (NOT a blunt
`drizzle-kit push`, per the cross-env-schema-drift convention). After applying to
both DBs, `pnpm --filter @workspace/db run push` is a clean no-op.

## Historical scripts (informational)

`artifacts/api-server/src/scripts/migrate-organizations.ts` is the one-time
consolidation script and still references these columns in raw SQL. It guards
column existence (`ADD COLUMN IF NOT EXISTS`) and has already run; it must not be
re-run as-is against a cleaned-up DB.
