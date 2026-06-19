# Runbook — 0049: Finance Reconciliation per-entity dimension

## Background

The "QuickBooks Review" workspace is being rebranded to **Finance Reconciliation**.
A core behaviour change ships with it: the app **stops auto-excluding money that
belongs to a fiscally sponsored Wildflower entity** (e.g. "Embracing Equity").

Previously such payments were classified `fiscally_sponsored` and dropped into the
**Excluded** queue, hiding them from fundraisers. Now each staged payment is
**attributed to its entity** (`staged_payments.entity_id`) and **kept in the review
queue**, filterable by a new per-entity selector. Wildflower Foundation is the
default bucket for unattributed (null-entity) rows.

The `fiscally_sponsored` exclusion-reason enum value is retained for historical
rows but is no longer produced.

## Schema vs. data

- **Schema** — `staged_payments.entity_id` (text, FK → `entities(id)` `ON DELETE
  SET NULL`) and its index ship to production through the normal **Publish**
  (drizzle) diff. This file does **not** create them.
- **Data** — this file performs the one-time, idempotent data alignment below.

## What 0049 does (all idempotent)

1. **Seed + activate entities.** Ensures `wildflower_foundation` (default bucket)
   and the five fiscally-sponsored entities `detectEntity` attributes to exist
   (`ON CONFLICT (id) DO NOTHING`) and are `active = true`.
2. **Disable the legacy rule.** Sets `enabled = false` on the persisted
   `seed_fiscally_sponsored` handling rule (guarded: only that row, only while it
   still carries `exclusion_reason = 'fiscally_sponsored'` and is enabled). Kept,
   not deleted, so it is reversible and historical `matched_rule_id` refs stay valid.
3. **Re-surface auto-excluded rows.** Rows with `status = 'excluded'`,
   `exclusion_reason = 'fiscally_sponsored'`, `classification_source = 'auto'` go
   back to `status = 'pending'`, `exclusion_reason = NULL`, `matched_rule_id = NULL`.
   A human's manual exclusion (source `manual`) is left untouched.
4. **Backfill `entity_id`.** A faithful SQL mirror of `ENTITY_MARKERS` /
   `detectEntity` in
   `artifacts/api-server/src/lib/quickbooksExclusionRules.ts`. Only **sets**
   `entity_id` where a marker matches; never clears an existing attribution.

### ⚠️ TS ⇄ SQL lockstep

Step 4 mirrors `detectEntity` exactly. The TS scans, per field,
`value.toLowerCase().includes(marker)` over `payerName`, `rawReference`,
`lineDescription`, `lineClasses[]`, `lineItemNames[]`, `lineAccountNames[]`. The
SQL concatenates those same columns (arrays joined on `\n`, which no multi-word
marker contains, so a marker can never falsely span two array elements) and tests
each marker with `ILIKE '%marker%'`, first match in declaration order winning:

| entity_id                  | markers (case-insensitive substring)            |
| -------------------------- | ----------------------------------------------- |
| `embracing_equity`         | `embracing equity`                              |
| `black_wildflowers_fund`   | `black wildflower`                              |
| `tierra_indigena`          | `tierra indígena`, `tierra indigena`            |
| `observation_support_tech` | `observant education`, `observation support`    |
| `rising_tide`              | `rising tide`                                   |

**"Sunlight" is intentionally NOT attributed.** `sunlight_debt` and
`sunlight_grants` are the same entity awkwardly split across two rows (debt vs.
revenue); a bare "sunlight" marker can't disambiguate them, so those rows stay
unattributed (Foundation default) for a fundraiser to file by hand. Any change to
the markers here must change `ENTITY_MARKERS` in lockstep (and vice-versa).

## Pre-flight (review the scope before running)

```sql
-- How many rows the system auto-excluded as fiscally_sponsored (re-surface target):
SELECT count(*) FROM staged_payments
 WHERE status = 'excluded' AND exclusion_reason = 'fiscally_sponsored'
   AND classification_source = 'auto';

-- Is the legacy rule still enabled?
SELECT id, enabled, priority, conditions
  FROM quickbooks_handling_rules WHERE id = 'seed_fiscally_sponsored';

-- Entities present today:
SELECT id, name, active FROM entities ORDER BY id;
```

## Apply

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0049_finance_reconciliation_entity_dimension.sql
```

Transactional; safe to re-run (a re-run is a no-op). Watch for the `NOTICE 0049:`
summary line it prints at the end.

## Verification

```sql
-- Rule disabled (expect enabled = f):
SELECT id, enabled FROM quickbooks_handling_rules WHERE id = 'seed_fiscally_sponsored';

-- No auto-classified fiscally_sponsored rows left excluded (expect 0):
SELECT count(*) FROM staged_payments
 WHERE status = 'excluded' AND exclusion_reason = 'fiscally_sponsored'
   AND classification_source = 'auto';

-- Entity attribution distribution:
SELECT e.name, count(*) AS staged_rows
  FROM staged_payments s JOIN entities e ON e.id = s.entity_id
 GROUP BY e.name ORDER BY staged_rows DESC;

-- Fiscally-sponsored entities active (expect active = t for all five):
SELECT id, name, active FROM entities
 WHERE id IN ('embracing_equity','black_wildflowers_fund','tierra_indigena',
              'observation_support_tech','rising_tide')
 ORDER BY id;
```

## Rollback (if needed)

The change is intentionally conservative. To revert behaviour:

```sql
-- Re-enable the legacy exclusion rule:
UPDATE quickbooks_handling_rules SET enabled = true, updated_at = now()
 WHERE id = 'seed_fiscally_sponsored';
```

Re-surfaced rows can be re-excluded individually from the UI. `entity_id`
attribution is non-destructive (it never minted or deleted a gift) and can be
cleared with `UPDATE staged_payments SET entity_id = NULL` if a clean slate is
wanted, though there is no need.
