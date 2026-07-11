-- 0053 — full-text (trigram) search indexes for the unified GET /search endpoint
--        AND the Potential Duplicates scan (GET /potential-duplicates)
--
-- The unified search matches each core entity HYBRID: substring `ILIKE '%q%'`
-- OR pg_trgm fuzzy `col % q`, ranked by `similarity()`. Both the `%` operator
-- and `similarity()` come from the `pg_trgm` extension; these GIN indexes
-- (gin_trgm_ops) make both the ILIKE substring scan and the `%` match fast.
--
-- The Potential Duplicates page's name-similarity self-joins
-- (organizations.name % / people.full_name %) rely on the same
-- organizations_name_trgm / people_full_name_trgm indexes; without them each
-- scan is a ~1s sequential scan instead of milliseconds.
--
-- This file is idempotent (CREATE EXTENSION / CREATE INDEX IF NOT EXISTS) and
-- touches no row data. The org/person/household *_name_trgm indexes were first
-- created by 0023 (QuickBooks matcher) — re-declaring them here is a harmless
-- no-op and keeps the full search index set in one place. The opportunities /
-- gifts name indexes are new.
--
-- Publish never issues CREATE EXTENSION and cannot express gin_trgm_ops in the
-- Drizzle schema, so this must be applied by hand in every environment (and is
-- re-applied after any `drizzle-kit push`, which drops indexes it can't see in
-- the schema). See 0053_fulltext_search_trgm_RUNBOOK.md.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Name columns matched by the donor-facing entities.
CREATE INDEX IF NOT EXISTS organizations_name_trgm
  ON organizations USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS people_full_name_trgm
  ON people USING gin (full_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS households_name_trgm
  ON households USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS opportunities_and_pledges_name_trgm
  ON opportunities_and_pledges USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS gifts_and_payments_name_trgm
  ON gifts_and_payments USING gin (name gin_trgm_ops);
