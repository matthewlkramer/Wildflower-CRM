-- 0024_quickbooks_clean_reingest.sql
-- One-time clean re-ingestion of QuickBooks staged payments.
--
-- WHY
--   staged_payments accumulated pre-rewrite rows: whole bank Deposits staged
--   before per-line splitting, LinkedTxn dedupe and pg_trgm scoring existed.
--   The incremental, watermark-based sync NEVER re-pulls that back-catalog, so
--   those rows sit forever as undeduplicated lump deposits that bury the real
--   per-donor payments in the queue and never auto-apply.
--
-- WHAT
--   Wipe ALL staged_payments rows (resolved + unresolved) and reset the
--   per-connection sync watermark so the next "Sync now" re-pulls the FULL
--   QuickBooks history cleanly (per-line deposits, LinkedTxn dedupe,
--   classification, scoring, auto-apply).
--
-- SAFE
--   Does NOT touch gifts_and_payments or gift_allocations. The gifts previously
--   auto-created from QuickBooks (each carrying an allocation) are KEPT. On the
--   re-pull the matcher RECONCILES (links) to them by identical
--   donor/amount/date rather than minting duplicates. Verify post-sync — see
--   the runbook.
--
-- IDEMPOTENT
--   Re-running deletes nothing the second time and simply re-resets the
--   watermark. Wrapped in a single transaction.

BEGIN;

DELETE FROM staged_payments;

UPDATE quickbooks_connections
SET sync_watermark = NULL,
    last_synced_at  = NULL,
    last_error      = NULL,
    updated_at      = now();

COMMIT;
