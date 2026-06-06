-- 0034_quickbooks_deposit_grouping.sql
--
-- Adds the columns + indexes that back MANUAL deposit grouping in the
-- staged-payments reconciler: several QuickBooks staged payments that share ONE
-- underlying bank Deposit can be grouped into a "deposit unit" and reconciled as
-- a whole to ONE existing CRM gift (multi-allocation), fee-band gated.
--
--   * qb_deposit_id            — the bank Deposit a staged row belongs to. Only
--                                rows sharing this id may be grouped together;
--                                rows with a NULL value are never offered for
--                                grouping. Folded on at pull time and preserved
--                                on incremental re-sync (the deposit may fall
--                                outside the watermark window).
--   * group_reconciled_gift_id — set on EVERY member of a grouped reconciliation
--                                (FK → gifts_and_payments, ON DELETE SET NULL).
--                                The "representative" member (lowest id) ALSO
--                                carries matched_gift_id = the same gift, so the
--                                gift still shows as "linked" through the
--                                existing single-link path; the other members
--                                resolve to the gift via this column alone.
--                                Cleared for the whole group on revert.
--
-- Publish applies column/index/constraint diffs but NEVER `CREATE EXTENSION`;
-- these are plain columns/indexes/FK, so this file simply mirrors what Publish
-- would do, made fully idempotent so a human can run it by hand on prod first.
--
-- Idempotent and additive (safe to re-run). No data is rewritten: existing rows
-- get NULL for both columns, which is exactly "ungrouped".

ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS qb_deposit_id text;

ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS group_reconciled_gift_id text;

-- FK on group_reconciled_gift_id → gifts_and_payments (ON DELETE SET NULL).
-- The drizzle-generated constraint name is truncated to Postgres's 63-char
-- identifier limit, so add it under a stable explicit name guarded by a probe
-- that matches EITHER name (so we never double-add it).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'staged_payments'::regclass
      AND contype = 'f'
      AND conname LIKE 'staged_payments_group_reconciled_gift_id%'
  ) THEN
    ALTER TABLE staged_payments
      ADD CONSTRAINT staged_payments_group_reconciled_gift_id_fk
      FOREIGN KEY (group_reconciled_gift_id)
      REFERENCES gifts_and_payments (id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS staged_payments_qb_deposit_id_idx
  ON staged_payments (qb_deposit_id);

CREATE INDEX IF NOT EXISTS staged_payments_group_reconciled_gift_id_idx
  ON staged_payments (group_reconciled_gift_id);
