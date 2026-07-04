-- Migration 0094: Physically DROP the three fully-deprecated "counts toward goal"
-- / "sync gap" columns. The authoritative signal now lives per-allocation on
-- gift_allocations.counts_toward_goal (money scope lives on the child allocation
-- rows — invariant #2). This is the deferred section-3 drop of migration 0080.
--
-- DROPS:
--   gifts_and_payments.counts_toward_goal   header flag — superseded by allocations
--   staged_payments.counts_toward_goal      ingest copy — mints now recompute the
--                                           allocation flag from isGovernmentReimbursement
--   staged_payments.sync_gap                never-shipped annotation from 0074 (no API/UI)
--
-- SAFE TO DROP — verified read-only against BOTH dev and prod:
--   * 0080's one-time header/staged -> allocation backfill has already run in prod
--     (sections 1a/1b/1c, all five staged->gift link paths). Every non-goal signal
--     now lives on the allocations.
--   * prod gifts_and_payments.counts_toward_goal = 790/790 TRUE (zero header signal).
--   * prod staged_payments.sync_gap = 3251/3251 FALSE (never held data).
--   * "un-propagated" = 0 in dev AND prod: no gift header=false with an allocation
--     still true; no staged=false whose linked gift still has a counting allocation
--     (checked across created/matched/group_reconciled + staged_payment_splits +
--     payment_applications).
--   * No un-minted staged=false row has a non-CSP payer (0 in dev AND prod), so every
--     future mint of a pending non-goal row RECOMPUTES the flag onto the allocation
--     from isGovernmentReimbursement(payer_name == "CSP") — the staged column is
--     vestigial. Goal/received SUMs read ONLY gift_allocations.counts_toward_goal, so
--     this CANNOT move a counted dollar.
--
-- No indexes, FKs, or enum types depend on these plain boolean columns.
--
-- IF EXISTS -> idempotent / re-runnable (a second run is a no-op).
--
-- ORDERING (prod) — Publish FIRST, THEN this SQL (same direction as 0093). The
-- columns are no longer WRITTEN, but the currently-deployed prod build still SELECTs
-- them: they remain in the Drizzle schema and select()/getTableColumns emit every
-- schema column (the response is scrubbed only AFTER the read). Dropping them before
-- the schema-removal code deploys would 500 every gift / staged-row read. Publish
-- diffs dev-DB vs prod-DB (NOT the schema source), so keep BOTH DBs holding these
-- columns THROUGH Publish (do NOT drop dev alone first, or Publish would see a
-- prod-only column and propose a destructive prod drop that aborts the whole diff).
-- Only AFTER the new code is live in prod apply this file to prod AND dev.
--
-- Apply with psql -1 (wraps the file in ONE transaction; do NOT add BEGIN/COMMIT):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0094_drop_counts_toward_goal_deprecated_cols.sql   (prod)
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0094_drop_counts_toward_goal_deprecated_cols.sql   (dev)

ALTER TABLE gifts_and_payments
  DROP COLUMN IF EXISTS counts_toward_goal;

ALTER TABLE staged_payments
  DROP COLUMN IF EXISTS counts_toward_goal,
  DROP COLUMN IF EXISTS sync_gap;

-- Verification (run by hand AFTER applying) -----------------------------------
--   -- All three columns gone (expect zero rows):
--   SELECT table_name, column_name FROM information_schema.columns
--   WHERE (table_name = 'gifts_and_payments' AND column_name = 'counts_toward_goal')
--      OR (table_name = 'staged_payments'    AND column_name IN ('counts_toward_goal','sync_gap'));
--
--   -- Authoritative allocation flag untouched (expect a true/false distribution):
--   SELECT counts_toward_goal, count(*) FROM gift_allocations GROUP BY 1 ORDER BY 1;
