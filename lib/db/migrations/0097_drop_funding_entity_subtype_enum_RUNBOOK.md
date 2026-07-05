# Runbook — 0097 Retire the orphaned `funding_entity_subtype` enum type

## What this does

Drops the now-unused `funding_entity_subtype` Postgres enum type. The type was
superseded by the unified `entity_type` enum (`entityTypeEnum`) when the split
funders/organizations model was consolidated into a single `organizations` table.
Its own comment in `_enums.ts` flagged it as "kept for migration compatibility —
removed after Phase 2 push." With no column, function, or default left
referencing it, this type is dead weight.

```sql
DROP TYPE IF EXISTS funding_entity_subtype;
```

### ⚠️ Do NOT touch `entity_type`

The `entity_type` enum is **still LIVE** — it is the unified successor that
replaced `funding_entity_subtype`. This migration is strictly the
`funding_entity_subtype` type.

## Why it is safe (verified zero references, dev AND prod)

- No table column has `udt_name = 'funding_entity_subtype'`. Verified read-only
  against **both dev and prod** (`information_schema.columns` returned zero rows).
- No function, view, or default references the type — a `pg_depend` join returned
  **zero** non-internal dependents in both dev and prod.
- The Drizzle schema no longer defines any column of this type. The lone remaining
  `fundingEntitySubtypeEnum` export in `lib/db/src/schema/_enums.ts` (used by no
  table) is removed by this task's code. `drizzle-kit` only manages enums attached
  to a column, so deleting that orphan export produces **no Publish diff**.
- The remaining code references (`fundingEntitySubtypeMap` in
  `import-airtable.mjs` and `funding_entity_subtype::text` in
  `migrate-organizations.ts`) operate on text/column values, NOT on this pg enum
  type, so they are unaffected by the drop.
- **No CASCADE.** A bare `DROP TYPE` (no `CASCADE`) fails loudly if any dependency
  still exists — it can never silently cascade-drop a live column.

## Pre-checks (re-run read-only against prod right before scheduling the drop)

```sql
-- The type exists (so the drop is meaningful, not a no-op):
SELECT typname FROM pg_type WHERE typname = 'funding_entity_subtype';

-- NOTHING references it — expect ZERO rows:
SELECT table_name, column_name FROM information_schema.columns
WHERE udt_name = 'funding_entity_subtype';

-- entity_type is untouched and still in use (expect ONE row):
SELECT typname FROM pg_type WHERE typname = 'entity_type';
```

## Deploy ordering (prod)

1. **Publish ordering is a non-issue here.** The deployed prod build does not
   reference the `funding_entity_subtype` *type* at all — the columns were removed
   long ago in the funders/organizations consolidation; this task only deletes an
   unused enum export. Publish diffs **dev-DB vs prod-DB**, and both hold the
   identical orphaned type, so the diff is clean and proposes nothing.
2. Apply this file to **prod**:
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0097_drop_funding_entity_subtype_enum.sql
   ```
3. Apply the SAME file to **dev**:
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0097_drop_funding_entity_subtype_enum.sql
   ```

`psql -1` wraps the file in ONE transaction — do not add `BEGIN`/`COMMIT` inside it.

## Idempotency

`DROP TYPE IF EXISTS` → safe to re-run; a second run is a no-op.

## Verify (read-only, after applying)

```sql
-- funding_entity_subtype type gone (expect ZERO rows):
SELECT typname FROM pg_type WHERE typname = 'funding_entity_subtype';

-- entity_type type UNTOUCHED (expect ONE row):
SELECT typname FROM pg_type WHERE typname = 'entity_type';
```

## Rollback

Structure-only if ever needed:

```sql
CREATE TYPE funding_entity_subtype AS ENUM
  ('family_foundation','institutional_foundation','corporate_foundation',
   'community_foundation','bank_foundation','family_office_trust','intermediary',
   'government','nonprofit','corporation','capital_provider',
   'philanthropic_advisor','cdfi','education_forprofit','competition',
   'public_private','daf_platform','platform');
```

There is nothing to restore into it — the authoritative entity-type signal lives
on the unified `entity_type` enum.
