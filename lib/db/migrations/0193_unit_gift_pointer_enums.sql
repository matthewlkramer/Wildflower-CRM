-- 0193: enum groundwork for the unit→gift pointer cutover
-- (docs/adr-unit-gift-pointer.md).
--
-- Kept SEPARATE from 0194 on purpose: PostgreSQL forbids USING a newly added
-- enum value inside the same transaction that adds it, and 0194's CHECK
-- constraints + backfill reference it. Apply 0193 first, then 0194.
--
-- Apply after Publish, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0193_unit_gift_pointer_enums.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

ALTER TYPE source_link_type ADD VALUE IF NOT EXISTS 'unit_gift_corroboration';
