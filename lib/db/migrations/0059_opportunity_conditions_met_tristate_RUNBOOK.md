# 0059 — Tri-state "conditions met" on opportunities & pledges

## What this does

"Conditions met" on `opportunities_and_pledges` was a boolean (yes/no). Grants are
often only **partially** satisfied, so the column becomes a three-value enum:

```
opportunity_conditions_met = 'no' | 'partial' | 'yes'
```

- `conditions_met` is converted in place from `boolean` to the new enum.
- Existing values are preserved: `false`/unset → `'no'`, `true` → `'yes'`.
- `'partial'` is new and only ever set deliberately (see 0060 for the Avi Nash
  Seed Challenge Grant).

## Non-destructive guarantee

- The conversion uses an explicit `USING` cast, so every existing row keeps its
  value (no drop/recreate).
- The file is idempotent: the enum create is guarded, and the column swap runs
  **only while the column is still boolean**. Re-running is a no-op.

## Apply — BEFORE Publish

A boolean→enum type change on a live database must be done deliberately with a
`USING` cast. Drizzle's interactive push cannot generate one and may drop/recreate
the column (losing data), so **apply this file before the Publish that ships the
schema change**. Afterwards the column already matches the target type, so the
Publish diff is an empty no-op.

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0059_opportunity_conditions_met_tristate.sql
```

(The file has no explicit `BEGIN`/`COMMIT`, so `-1` wraps the whole migration in
one transaction — all-or-nothing.)

Expected NOTICE on success (counts will vary):

```
0059: conditions_met no=<N>, partial=0, yes=<M>
```

## Verify

```sql
-- Column is now the enum type
SELECT data_type, udt_name
  FROM information_schema.columns
 WHERE table_name = 'opportunities_and_pledges' AND column_name = 'conditions_met';
-- expect udt_name = 'opportunity_conditions_met'

-- Enum has all three values
SELECT enum_range(NULL::opportunity_conditions_met);
-- expect {no,partial,yes}

-- No rows lost; distribution
SELECT conditions_met, count(*) FROM opportunities_and_pledges GROUP BY 1 ORDER BY 1;
```

## Rollback

Not normally needed. If required and no `'partial'` rows exist:

```sql
ALTER TABLE opportunities_and_pledges ALTER COLUMN conditions_met DROP DEFAULT;
ALTER TABLE opportunities_and_pledges
  ALTER COLUMN conditions_met TYPE boolean
  USING (conditions_met = 'yes');
ALTER TABLE opportunities_and_pledges ALTER COLUMN conditions_met SET DEFAULT false;
ALTER TABLE opportunities_and_pledges ALTER COLUMN conditions_met SET NOT NULL;
DROP TYPE opportunity_conditions_met;
```
