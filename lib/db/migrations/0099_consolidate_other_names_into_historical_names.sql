-- 0099  Consolidate organizations.other_names → organizations.historical_names
--
-- Context: `other_names` (single free-text alias/abbreviation string) and
-- `historical_names` (text[] of prior names) were two overlapping fields. Per
-- the fundraising team's decision we collapse aliases into the single
-- structured `historical_names` list. This file backfills the data; the
-- physical `other_names` column is dropped in a later migration once this has
-- been confirmed applied in prod (deprecate → backfill → drop).
--
-- Behaviour:
--   * Appends each `other_names` value to `historical_names`, splitting on ';'
--     (a safe list delimiter — e.g. "Foo Corp; FC" → two entries). Values with
--     no ';' are kept whole (org legal names can contain commas, so we never
--     split on ',').
--   * Only adds elements not already present in `historical_names`.
--   * Does NOT clear `other_names` — the source is retained as a safety copy
--     until the phase-2 column drop (non-destructive).
--
-- Idempotent: re-running matches no rows (every element already absorbed) and
-- is a no-op. Do NOT wrap in BEGIN/COMMIT — apply with `psql -1`.

UPDATE organizations o
SET historical_names =
  COALESCE(o.historical_names, '{}')
  || ARRAY(
       SELECT btrim(part)
       FROM regexp_split_to_table(o.other_names, ';') AS part
       WHERE btrim(part) <> ''
         AND NOT (COALESCE(o.historical_names, '{}') @> ARRAY[btrim(part)])
     )
WHERE o.other_names IS NOT NULL
  AND btrim(o.other_names) <> ''
  AND EXISTS (
    SELECT 1
    FROM regexp_split_to_table(o.other_names, ';') AS part
    WHERE btrim(part) <> ''
      AND NOT (COALESCE(o.historical_names, '{}') @> ARRAY[btrim(part)])
  );
