# Runbook — 0099 Consolidate `other_names` into `historical_names`

## What this does

Backfills every `organizations.other_names` value into the structured
`organizations.historical_names text[]` list, then leaves the source column in
place. This is **phase 1** of collapsing the two overlapping alias fields into
one (decision: the fundraising team wants a single clean alias list). The
physical `other_names` column is dropped in a **later** migration once this
backfill is confirmed applied in prod (deprecate → backfill → drop, same as
0093–0097).

| Field | Before | After phase 1 | After phase 2 (later) |
| --- | --- | --- | --- |
| `other_names` | single free-text alias | retained (dead safety copy, no longer read/written) | dropped |
| `historical_names` | prior names `text[]` | prior names **+ former aliases** | unchanged |

## Behaviour

- Splits each `other_names` value on `;` (a safe list delimiter — e.g.
  `"Foo Corp; FC"` → two entries). Values with **no** `;` are kept whole. We
  never split on `,` because org legal names contain commas (`Foo, Inc.`).
- Appends only elements **not already present** in `historical_names`.
- Does **not** clear `other_names` — the source is kept as a safety copy until
  the phase-2 drop. Non-destructive.

## Why it is safe

- Purely additive to `historical_names`; touches no other table/column.
- Both columns already exist in prod, so this does **not** depend on Publish —
  it can be applied **before or after** Publish. It must only run **before** the
  phase-2 column drop.
- In dev, 0 rows have BOTH fields set, so no merge conflicts; prod is the same
  shape (a small handful of curated `other_names` rows).

## Idempotency

Re-running matches no rows (every element already absorbed via the `@>` guard)
and is a no-op. Do **not** wrap in `BEGIN`/`COMMIT` — apply with `psql -1`.

## Apply

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0099_consolidate_other_names_into_historical_names.sql
psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0099_consolidate_other_names_into_historical_names.sql
```

(`$DATABASE_URL` = dev; already applied there during development.)

## Verify (read-only, after applying)

```sql
-- Expect 0: every non-empty other_names value fully absorbed into historical_names.
SELECT count(*) FROM organizations o
WHERE o.other_names IS NOT NULL AND btrim(o.other_names) <> ''
  AND EXISTS (
    SELECT 1 FROM regexp_split_to_table(o.other_names, ';') AS part
    WHERE btrim(part) <> ''
      AND NOT (COALESCE(o.historical_names, '{}') @> ARRAY[btrim(part)])
  );
```

## Rollback

Non-destructive: `other_names` is untouched and still holds the originals. If
ever needed, the appended `historical_names` entries can be removed by hand;
there is no data loss to recover from.
