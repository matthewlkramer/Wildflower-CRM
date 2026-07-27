-- 0189: enum groundwork for QBO-grain source links
-- (docs/adr-qbo-evidence-grain.md).
--
-- Kept SEPARATE from 0190 on purpose: PostgreSQL forbids USING a newly added
-- enum value inside the same transaction that adds it, and 0190's CHECK
-- constraints reference these values. Apply 0189 first, then 0190.
--
-- NOTE: 0188 is reserved by the on-hold over-composition fix (PR #55).
--
-- Apply after Publish, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0189_source_link_qbo_grain_enums.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

ALTER TYPE source_link_type ADD VALUE IF NOT EXISTS 'qbo_register_deposit';
ALTER TYPE source_link_type ADD VALUE IF NOT EXISTS 'qbo_register_unit';
ALTER TYPE source_link_type ADD VALUE IF NOT EXISTS 'qbo_line_deposit';
ALTER TYPE source_link_type ADD VALUE IF NOT EXISTS 'payout_qb_settlement';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'source_link_match_basis') THEN
    CREATE TYPE source_link_match_basis AS ENUM (
      'same_day_unique_amount',
      'one_day_unique_amount',
      'two_day_unique_amount',
      'three_day_unique_amount',
      'same_donor_multi_row_sum',
      'deposit_header_exact',
      'deposit_header_ambiguous',
      'settled_pairing',
      'human'
    );
  END IF;
END $$;
