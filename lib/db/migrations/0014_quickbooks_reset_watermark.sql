-- Migration 0014: One-time — reset the QuickBooks sync watermark to force a
-- FULL re-pull of the incoming-money back-catalog.
--
-- WHY: the QuickBooks sync is incremental — it only pulls entities updated since
-- `sync_watermark` (see quickbooksSync.ts). The ~3,000 rows staged before the
-- line-item-detail capture shipped therefore never get their
-- line_item_names / line_account_names enriched by the scheduled sync, because
-- they sit behind the watermark and are never re-fetched. The membership
-- auto-exclude rule (and the runbook's discovery query) both depend on that
-- line detail, so the back-catalog must be re-pulled once.
--
-- WHAT THIS DOES: sets sync_watermark = NULL for every connection. The next sync
-- (Settings → QuickBooks → "Sync now", or the 30-min scheduler) then pulls the
-- full history. Every existing row hits the idempotent ON CONFLICT upsert, which
-- refreshes ONLY the line-detail columns + updated_at for rows still in
-- 'pending' or 'excluded' — status, exclusion_reason, donor match, and any
-- approve/reject/re-include decision are left untouched (quickbooksSync.ts
-- setWhere). So this is safe to run AFTER 0013 has cleared the zero/loan noise:
-- the re-pull will NOT resurrect those excluded rows.
--
-- SAFETY:
--   * Non-destructive: no rows are inserted or deleted; only the watermark moves.
--   * The very next sync re-advances the watermark to the newest LastUpdatedTime,
--     so normal incremental syncing resumes automatically afterward.
--   * This is a ONE-TIME action, not idempotent in the strict sense: re-running it
--     after a sync has re-advanced the watermark would trigger another full
--     re-pull. Run it once, then let the sync run.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0014_quickbooks_reset_watermark.sql
--
-- AFTER APPLYING: trigger a sync (Settings → QuickBooks → "Sync now") so the
-- full re-pull runs and enriches line_item_names / line_account_names. Then run
-- the membership discovery query in the 0012-0013 runbook.

BEGIN;

UPDATE quickbooks_connections
   SET sync_watermark = NULL,
       updated_at = now();

-- Verification (after the subsequent "Sync now" completes):
--   SELECT count(*) FILTER (WHERE line_item_names IS NOT NULL) AS enriched,
--          count(*) AS total
--     FROM staged_payments;

COMMIT;
