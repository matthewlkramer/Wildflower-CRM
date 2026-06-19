# Runbook — 0054_duplicate_dismissals

## What this does

Adds the `duplicate_dismissals` table that backs the **potential-duplicates
review queue** (C8). Each row records a single organization-or-person pair that
an admin has explicitly marked **"not a duplicate"**, so the on-demand detector
never surfaces that pair again.

- `entity_type` — `'organization'` or `'person'` (CHECK-constrained).
- `id_a` / `id_b` — the two record ids, stored in canonical order (`id_a < id_b`,
  CHECK-constrained) so a pair is recorded once regardless of detector ordering.
- Unique index `(entity_type, id_a, id_b)` makes a dismissal idempotent.
- No foreign keys on `id_a`/`id_b` by design — they are polymorphic (org **or**
  person) and this is historical review state. A row pointing at a
  since-merged/deleted entity is harmless (that entity can no longer appear as a
  candidate) and stays out of the `mergeEntities` FK-inventory test.

## Safety

- **Additive and idempotent.** `CREATE TABLE IF NOT EXISTS` +
  `CREATE UNIQUE INDEX IF NOT EXISTS`. No existing data is read or modified.
- Re-running is a no-op.

## How to apply (production, by a human)

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0054_duplicate_dismissals.sql
```

Apply **after** the schema/code Publish (the table also ships via the normal
Drizzle schema diff; this file is the reviewed, idempotent equivalent for a
human-applied path). Order relative to Publish does not matter here because the
file is self-contained and creates the table itself.

## Verify

```sql
SELECT to_regclass('public.duplicate_dismissals') IS NOT NULL AS table_exists;
SELECT indexname FROM pg_indexes
WHERE tablename = 'duplicate_dismissals';
```
