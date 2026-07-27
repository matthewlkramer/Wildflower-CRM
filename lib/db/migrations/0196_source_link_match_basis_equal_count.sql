-- 0196: add 'same_day_equal_count_amount' to source_link_match_basis
-- (docs/adr-qbo-evidence-grain.md).
--
-- Used by the equal-count register↔deposit matcher: when N identical-amount
-- register rows on one date pair with exactly N same-amount deposits on the
-- same date (and no other open candidates of that amount within the ±3-day
-- window), the rows are interchangeable and pair one-to-one.
--
-- Apply after Publish, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0196_source_link_match_basis_equal_count.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

ALTER TYPE source_link_match_basis ADD VALUE IF NOT EXISTS 'same_day_equal_count_amount';
