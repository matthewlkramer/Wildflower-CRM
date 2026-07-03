# 0088 — `unit_groups` durable evidence grouping (RUNBOOK)

Plane 2 cleanup op (docs/reconciliation-design.md §4.6b, Decision 7). Introduces a
first-class, polymorphic, sync-safe association that generalizes
`staged_payments.source_group_id`, plus a mirror backfill from the existing
source groups.

This is the **additive dual-write** phase (WS2). The group/ungroup endpoints
already write `unit_groups` alongside `source_group_id`; **reads are not flipped
yet**. The read-flip (mechanism collapse) is a separate, later step gated on the
`parity:unit-groups` check passing on **prod**.

## What ships where

- **Schema** (`unit_groups`, `unit_group_members`, indexes, enum) reaches prod
  through the normal **Publish** (drizzle) diff.
- **This file** is the idempotent, self-contained equivalent (mirrors 0084) — it
  creates the same tables/indexes AND performs the one-time DATA backfill (step 3)
  that Publish will not do.

## Ordering

1. **Publish** the code/schema first (invariant #7 — Publish diffs the dev DB;
   this ships the tables and the dual-write route code).
2. Then run this file against prod to perform the backfill (and to be a no-op on
   the already-Published tables).

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0088_unit_groups.sql
```

Expect a NOTICE like:

```
NOTICE:  0088: unit_groups=<N> ; unit_group_members=<M> (backfilled from source_group_id >= 2-member groups)
```

## Idempotency / safety

- Re-running is a no-op: enum guard swallows `duplicate_object`; tables/indexes
  are `IF NOT EXISTS`; backfill INSERTs are `ON CONFLICT (id) DO NOTHING` on
  deterministic ids (`ug_<source_group_id>` / `ugm_<staged_payment_id>`).
- Nothing is dropped. `source_group_id` is left untouched — it remains the
  dual-write source of truth until Phase 7.

## Verify (read-only)

```sql
-- Every >= 2-member source group has a matching ug_ group.
SELECT sp.source_group_id, COUNT(*) AS members,
       (ug.id IS NOT NULL) AS has_unit_group
FROM staged_payments sp
LEFT JOIN unit_groups ug ON ug.id = 'ug_' || sp.source_group_id
WHERE sp.source_group_id IS NOT NULL
GROUP BY sp.source_group_id, ug.id
HAVING COUNT(*) >= 2
ORDER BY has_unit_group;   -- any FALSE row = a group the backfill missed

-- Membership count matches the number of grouped staged payments (>= 2 groups).
SELECT
  (SELECT COUNT(*) FROM unit_group_members WHERE evidence_source = 'quickbooks') AS members_rows,
  (SELECT COUNT(*) FROM staged_payments sp
     WHERE sp.source_group_id IN (
       SELECT source_group_id FROM staged_payments
       WHERE source_group_id IS NOT NULL
       GROUP BY source_group_id HAVING COUNT(*) >= 2)) AS grouped_staged;

-- Exclusivity holds (should return zero rows).
SELECT evidence_source, source_id, COUNT(*)
FROM unit_group_members
GROUP BY evidence_source, source_id
HAVING COUNT(*) > 1;
```

The full machine-checked gate is:

```bash
pnpm --filter @workspace/api-server run parity:unit-groups
```

It must exit `PASS` on **prod** before the read-flip (mechanism collapse) phase
begins. Optional `--out <path>` writes a machine-readable report.
