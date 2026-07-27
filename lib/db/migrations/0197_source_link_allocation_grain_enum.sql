-- 0197: add 'qbo_line_allocation' to source_link_type
-- (docs/adr-qbo-evidence-grain.md).
--
-- Allocation-grain QBO evidence claim: a QBO line (staged_payments row) that
-- was booked at allocation grain — one physical payment split by the
-- bookkeeper into several lines, one per accounting allocation — ties to the
-- gift_allocations row it generated. "Clues at many grains, dollars at one":
-- the dollar lives once on the merged payment unit; the line keeps its
-- allocation-grain provenance here.
--
-- Requires nothing. Required by 0198 (column + CHECK) and 0199 (data).
--
-- Apply after Publish, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0197_source_link_allocation_grain_enum.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

ALTER TYPE source_link_type ADD VALUE IF NOT EXISTS 'qbo_line_allocation';
