-- Additive development migration for the WFNEWS batch importer. Existing
-- rows remain untouched; a nullable unique key permits multiple legacy NULLs.
-- ALTER TYPE ADD VALUE is intentionally standalone: PostgreSQL cannot run it
-- inside a transaction block on supported development versions.
ALTER TYPE "wildflower_update_date_precision"
  ADD VALUE IF NOT EXISTS 'school_year';

ALTER TABLE "wildflower_update_items"
  ADD COLUMN IF NOT EXISTS "import_key" text,
  ADD COLUMN IF NOT EXISTS "qualification" text,
  ADD COLUMN IF NOT EXISTS "event_start_year" integer,
  ADD COLUMN IF NOT EXISTS "event_end_year" integer;

CREATE UNIQUE INDEX IF NOT EXISTS "wildflower_update_items_import_key_uq"
  ON "wildflower_update_items" ("import_key");