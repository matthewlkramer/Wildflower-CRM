-- Additive development migration for month/year-only date ranges.
ALTER TYPE "wildflower_update_date_precision"
  ADD VALUE IF NOT EXISTS 'month_range';

ALTER TABLE "wildflower_update_items"
  ADD COLUMN IF NOT EXISTS "event_start_month" integer,
  ADD COLUMN IF NOT EXISTS "event_end_month" integer;

ALTER TABLE "wildflower_update_sources"
  ADD COLUMN IF NOT EXISTS "publication_start_year" integer,
  ADD COLUMN IF NOT EXISTS "publication_start_month" integer,
  ADD COLUMN IF NOT EXISTS "publication_end_year" integer,
  ADD COLUMN IF NOT EXISTS "publication_end_month" integer;