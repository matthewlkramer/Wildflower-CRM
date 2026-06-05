-- 0023_quickbooks_match_rewrite.sql
--
-- QuickBooks payment matching/reconciliation rewrite — the parts NOT covered
-- by the normal Drizzle schema push.
--
-- The staged_payments table itself (new columns: qb_line_id, line_description,
-- classification_source, match_score, match_method, auto_applied,
-- matched_payment_intermediary_id, matched_gift_id; dropped: gift_was_linked)
-- and the new enums / enum values ship through the normal Publish/schema-push
-- flow. This file covers what push CANNOT do on its own:
--   1. the pg_trgm extension (push never issues CREATE EXTENSION), and
--   2. the trigram GIN indexes the scored fuzzy matcher relies on (they need
--      the extension to exist first, so they are not declared in the Drizzle
--      schema).
--
-- Idempotent. Apply with:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0023_quickbooks_match_rewrite.sql
--
-- NOTE: QuickBooks-owned tables hold no production data yet, so the
-- staged_payments rebuild is non-destructive in practice. quickbooks_connections
-- is NOT changed, so no QuickBooks reconnect is required.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram GIN indexes powering fuzzy donor-name matching (similarity / ILIKE)
-- in the scored matcher and the reconciler's name search.
CREATE INDEX IF NOT EXISTS organizations_name_trgm
  ON organizations USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS people_full_name_trgm
  ON people USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS households_name_trgm
  ON households USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS payment_intermediaries_name_trgm
  ON payment_intermediaries USING gin (name gin_trgm_ops);
