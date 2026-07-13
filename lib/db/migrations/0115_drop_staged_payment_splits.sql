-- Migration 0115: Physically DROP the staged_payment_splits table.
--
-- BACKGROUND. A "split" books ONE QuickBooks staged payment across MULTIPLE
-- existing gifts. Its authoritative store is now the payment_applications
-- cash-application ledger (docs/reconciliation-design.md §4.2, Phase 7): the
-- split route writes one counted QB ledger row per gift
-- (evidence_source = 'quickbooks', link_role = 'counted') and leaves ALL
-- THREE gift-link columns (matched_gift_id / created_gift_id /
-- group_reconciled_gift_id) NULL on the staged row. Every read that used to
-- consult staged_payment_splits (live-queue "resolved" predicate, revert,
-- combine/merge guards, audit linkType, split totals/names) was flipped onto
-- counted ledger rows in this task's code, and the split route's dual-write
-- into staged_payment_splits was removed. The table is therefore fully dead:
-- unread and unwritten by the new build.
--
-- This drops:
--   staged_payment_splits            (whole table, incl. its PK/FKs/indexes)
--
-- SAFE TO DROP: payment_applications is the SOLE authoritative home for split
-- links. Every split written since the ledger shipped was DUAL-written (one
-- counted QB ledger row per split row), and parity between the two stores was
-- verified during the dual-write phase. The GUARD below re-proves it at apply
-- time: it ABORTS the whole transaction if ANY surviving split row lacks its
-- matching counted ledger row, so a drop can never orphan a booked dollar.
-- This cannot move a counted dollar on its own — money reads already flow
-- exclusively through payment_applications (link_role = 'counted').
--
-- NOT dropped: the staged_payment_exclusion_reason enum values
-- 'processor_payout' and 'confirmed_excluded' — still read by revert paths.
--
-- IDEMPOTENT / re-runnable: the guard skips when the table is already gone,
-- and DROP TABLE IF EXISTS makes a second run a no-op.
--
-- ORDERING (prod) — Publish FIRST, THEN this SQL. The currently-deployed prod
-- build still WRITES staged_payment_splits (the dual-write), so dropping it
-- BEFORE the new code deploys would 500 every split call. Publish diffs dev-DB
-- vs prod-DB (not the schema source), so keep BOTH DBs holding this table
-- THROUGH Publish (do NOT drop dev alone first, or Publish would see a
-- prod-only table and propose a destructive prod drop that aborts the whole
-- diff). Only AFTER the new code is live in prod apply this file to prod AND
-- dev, back-to-back. See the runbook for the full sequence.
--
-- Apply with psql -1 (wraps the file in ONE transaction; do NOT add
-- BEGIN/COMMIT or it nests and warns):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0115_drop_staged_payment_splits.sql   (prod)
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0115_drop_staged_payment_splits.sql   (dev)

-- GUARD: abort if any split row is NOT mirrored by a counted QB ledger row.
-- (Runs inside the same psql -1 transaction as the DROP, so an abort leaves
-- the table fully intact.)
DO $$
DECLARE
  orphan_count bigint;
BEGIN
  IF to_regclass('public.staged_payment_splits') IS NULL THEN
    RAISE NOTICE 'staged_payment_splits already dropped — nothing to do.';
    RETURN;
  END IF;

  SELECT count(*) INTO orphan_count
  FROM staged_payment_splits s
  WHERE NOT EXISTS (
    SELECT 1
    FROM payment_applications pa
    WHERE pa.payment_id = s.staged_payment_id
      AND pa.gift_id = s.gift_id
      AND pa.evidence_source = 'quickbooks'
      AND pa.link_role = 'counted'
  );

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'ABORT: % staged_payment_splits row(s) have NO matching counted quickbooks payment_applications row. Backfill the ledger before dropping (see 0115 runbook).',
      orphan_count;
  END IF;

  RAISE NOTICE 'Guard passed: every staged_payment_splits row is mirrored by a counted QB ledger row.';
END $$;

DROP TABLE IF EXISTS staged_payment_splits;

-- Verification (run by hand AFTER applying) -----------------------------------
--   -- Table gone (expect NULL):
--   SELECT to_regclass('public.staged_payment_splits');
--
--   -- The authoritative store is untouched: counted QB ledger rows still
--   -- present (expect the same count as before the drop):
--   SELECT count(*) FROM payment_applications
--   WHERE evidence_source = 'quickbooks' AND link_role = 'counted';
--
--   -- Split-resolved staged rows (3 gift-link cols NULL + counted ledger rows)
--   -- still resolve out of the live queue (expect > 0 if prod has splits):
--   SELECT count(DISTINCT sp.id)
--   FROM staged_payments sp
--   JOIN payment_applications pa
--     ON pa.payment_id = sp.id
--    AND pa.evidence_source = 'quickbooks'
--    AND pa.link_role = 'counted'
--   WHERE sp.matched_gift_id IS NULL
--     AND sp.created_gift_id IS NULL
--     AND sp.group_reconciled_gift_id IS NULL;
