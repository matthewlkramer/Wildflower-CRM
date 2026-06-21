# 0060 — Avi Nash Seed Challenge Grant → conditions met = "Partial"

## What this does

Sets the **Avi Nash Seed Challenge Grant** (`opportunities_and_pledges.id =
'recSmHuyBYL310qux'`) `conditions_met` to `'partial'`. It is a conditional
(on-target) grant whose conditions are only partially satisfied.

## Requires

Run **after 0059** (the `conditions_met` column must already be the
`opportunity_conditions_met` enum).

## Non-destructive / idempotent

Targets the single row by its stable Airtable record id and only updates when the
value isn't already `'partial'`. Re-running is a no-op.

## Apply

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0060_avi_nash_seed_challenge_conditions_partial.sql
```

Expected NOTICE (1 on first run, 0 thereafter):

```
0060: Avi Nash Seed Challenge Grant rows set to partial = 1 (0 = already partial / not present)
```

## Verify

```sql
SELECT id, name, conditions_met
  FROM opportunities_and_pledges
 WHERE id = 'recSmHuyBYL310qux';
-- expect conditions_met = 'partial'
```
