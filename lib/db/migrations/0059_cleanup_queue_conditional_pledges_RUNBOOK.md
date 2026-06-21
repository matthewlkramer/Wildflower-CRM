# Runbook — 0059_cleanup_queue_conditional_pledges

## What this does

Seeds the **cleanup queue** (`cleanup_queue`) with one `open` item per
opportunity/pledge currently at the `conditional_commitment` stage, so the
fundraising team can work through them by hand.

Each seeded row:

- `target_type` = `'pledge'` — the UI links it to `/pledges/:id`.
- `target_id` = the `opportunities_and_pledges.id`.
- `reason_code` = `'conditional_commitment_stage'` — the idempotency category.
- `id` = `'cleanup_cc_' || op.id` — deterministic, so re-runs map to the same row.
- `note` — instructs a human to move the conditional details into the
  `conditions` field and re-stage to a non-conditional commitment stage.

The `cleanup_queue` table itself ships via the normal Drizzle schema diff /
Publish; this file only inserts seed rows.

## Scope (what this deliberately does NOT do)

- Does **not** change any opportunity's `stage`, `conditions`, or
  `conditions_met` — that cleanup is performed manually, per record.
- Does **not** remove or alter the `conditional_commitment` enum value.
- Does **not** introduce a tri-state "conditions met".

## Safety

- **Additive and idempotent.** Only `INSERT`s into `cleanup_queue`;
  `ON CONFLICT (target_type, target_id, reason_code) DO NOTHING` makes a re-run
  a no-op. The conflict is on the natural key (not `id`), so an item a human has
  already **resolved or dismissed** is NOT resurrected on re-run.
- No targeted records are read for modification or changed in any way.

## How to apply (production, by a human)

Run **after** the schema/code Publish (so `cleanup_queue` exists):

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0059_cleanup_queue_conditional_pledges.sql
```

The script `RAISE NOTICE`s the before/after counts and the number of
`conditional_commitment` pledges so you can confirm the seed matched.

## Verify

```sql
-- Count of seeded open items vs. conditional_commitment pledges (should match
-- on a fresh seed).
SELECT
  (SELECT count(*) FROM cleanup_queue
     WHERE reason_code = 'conditional_commitment_stage') AS cleanup_items,
  (SELECT count(*) FROM opportunities_and_pledges
     WHERE stage = 'conditional_commitment') AS conditional_pledges;

-- Spot-check a few seeded rows.
SELECT id, target_type, target_id, status, flagged_at
FROM cleanup_queue
WHERE reason_code = 'conditional_commitment_stage'
ORDER BY flagged_at DESC
LIMIT 10;
```
