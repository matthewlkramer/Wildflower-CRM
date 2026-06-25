-- 0078_backfill_historical_source_group_id.sql
--
-- DATA-ONLY backfill. Copies HISTORICAL grouping into the reconciliation
-- workbench's grouping field (staged_payments.source_group_id).
--
-- Background
-- ----------
-- The legacy /staged-payments/group-reconcile flow reconciled several staged
-- payments to ONE gift (e.g. a $65k + $15k pair of QuickBooks deposit lines
-- that together make an $80k gift). It stamped group_reconciled_gift_id on
-- EVERY member and matched_gift_id on exactly one deterministic representative.
-- It never set source_group_id.
--
-- The new reconciliation workbench groups cards purely by source_group_id, so
-- these historical groups are invisible as groups:
--   * groupRepresentativeWhere never collapses them (no shared source_group_id);
--   * the non-representative members (group_reconciled_gift_id set, but
--     matched_gift_id / created_gift_id NULL) are NOT excluded by the queue
--     filter (which only checks matched/created), so they LEAK into the queue as
--     standalone cards;
--   * approving such a standalone card compares ONE member's amount against the
--     FULL gift amount -> a false "amount mismatch" the user cannot resolve.
--
-- This backfill stamps a deterministic shared source_group_id
-- ('histgrp_' || <gift id>) on every member of each historical group that has
-- >= 2 members. The workbench then collapses each group to one representative
-- card whose summed total matches the gift -> no more orphan cards, no false
-- mismatch.
--
-- Member set
-- ----------
-- A historical group is identified by group_reconciled_gift_id (the legacy flow
-- set it on EVERY member, representative included). We therefore group by that
-- column; the deterministic id is derived from the gift so the assignment is
-- stable and the file is idempotent.
--
-- Non-destructive + idempotent
-- ----------------------------
--   * writes ONLY rows that are historically group-reconciled AND not already in
--     a source group (source_group_id IS NULL);
--   * restricted to gifts with >= 2 group-reconciled members (no degenerate
--     groups-of-one);
--   * deterministic id => re-running is a no-op (source_group_id is no longer
--     NULL on a second pass);
--   * touches ONLY source_group_id (+ updated_at). No donor / gift / amount /
--     status change, no schema change, no gift / allocation / analytics impact.
--     source_group_id is a pure staged-payments review-state column.
--
-- How to apply (from the repo root; NOT wrapped in BEGIN/COMMIT here -- the
-- psql -1 flag wraps the whole file in a single transaction):
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0078_backfill_historical_source_group_id.sql
--
-- Expected on production: ~54 rows updated across 19 groups. Verify with the
-- SELECTs in 0078_backfill_historical_source_group_id_RUNBOOK.md.

UPDATE staged_payments sp
SET source_group_id = 'histgrp_' || sp.group_reconciled_gift_id,
    updated_at = now()
WHERE sp.group_reconciled_gift_id IS NOT NULL
  AND sp.source_group_id IS NULL
  AND sp.group_reconciled_gift_id IN (
    SELECT group_reconciled_gift_id
    FROM staged_payments
    WHERE group_reconciled_gift_id IS NOT NULL
    GROUP BY group_reconciled_gift_id
    HAVING COUNT(*) >= 2
  );
