-- Migration 0107: Physically DROP two long-deprecated, fully-inert columns:
--
-- DROPS:
--   organizations.other_names        consolidated into `historical_names` (migration
--                                    0099). No longer read or written by the app —
--                                    removed from the API spec, UI, and email
--                                    intelligence long ago.
--   staged_payments.needs_research   deprecated "needs research" boolean — superseded
--                                    by the Cleanup Queue (an OPEN cleanup_queue row
--                                    with target_type='staged_payment',
--                                    reason_code='needs_research', surfaced as the
--                                    derived read-only `flaggedForResearch` badge).
--
-- SAFE TO DROP — verified read-only against the schema-removal build:
--   * other_names: NOT read or written by any deployed code. It was already excluded
--     from the shared org response projection (destructured out before the SELECT was
--     built), so no query names it; it was also removed from the entity-merge override
--     field list. The only remaining textual references are the stale Airtable importer
--     (import-airtable.mjs — a known follow-up, targets the OLD split model, never run)
--     and the one-time migrate-organizations.ts consolidation script (raw-SQL strings;
--     already run). Neither is part of the serving path.
--   * needs_research: already stripped from EVERY staged-payment response projection
--     (stagedSelect / stagedReturnColumns / StagedReturnRow) and never written — the
--     "flag for research" flow lives entirely in the Cleanup Queue.
--   * Neither column has an index, FK, or enum dependency (both are plain scalar
--     columns), so nothing else is auto-dropped.
--
-- IF EXISTS -> idempotent / re-runnable (a second run is a no-op).
--
-- ORDERING (prod) — Publish FIRST, THEN this SQL (same direction as 0104/0105).
-- Both columns are ALREADY unselected by the deployed build, so a drop would not 500
-- reads either way. The binding constraint is the Publish DIFF: Publish compares the
-- dev-DB against the prod-DB (NOT the schema source). If you drop dev alone first,
-- the next Publish sees a prod-only column and proposes a DESTRUCTIVE prod drop that
-- aborts the whole diff (additive changes skipped -> 500 healthcheck). So keep BOTH
-- DBs holding these columns THROUGH Publish, and only AFTER the new (schema-removal)
-- code is live in prod apply this file to prod AND dev, back-to-back, with NO Publish
-- in between.
--
-- Apply with psql -1 (wraps the file in ONE transaction; do NOT add BEGIN/COMMIT):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0107_drop_other_names_staged_needs_research.sql   (prod)
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0107_drop_other_names_staged_needs_research.sql   (dev)

ALTER TABLE organizations
  DROP COLUMN IF EXISTS other_names;

ALTER TABLE staged_payments
  DROP COLUMN IF EXISTS needs_research;

-- Verification (run by hand AFTER applying) -----------------------------------
--   -- Both columns gone (expect ZERO rows):
--   SELECT table_name, column_name FROM information_schema.columns
--   WHERE (table_name = 'organizations'   AND column_name = 'other_names')
--      OR (table_name = 'staged_payments' AND column_name = 'needs_research');
--
--   -- Historical names still present on organizations (expect a non-zero count):
--   SELECT count(*) FROM organizations WHERE historical_names IS NOT NULL;
--
--   -- "Needs research" still lives in the Cleanup Queue (expect the queue to work):
--   SELECT count(*) FROM cleanup_queue
--   WHERE target_type = 'staged_payment' AND reason_code = 'needs_research';
