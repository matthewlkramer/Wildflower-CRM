-- 0153 — Split QuickBooks records into reconciliation units (schema DDL).
--
-- Implements the ratified workbench action "Split QuickBooks record into
-- reconciliation units" (docs/workbench-business-rules.md §7.2). A synthetic
-- CHILD staged_payments row carries split_parent_id -> the real sync-owned
-- mirror row (which is never edited — INV-G) and NULL qb_entity_id, so the
-- sync's idempotency upsert (unique on realm_id, qb_entity_type, qb_entity_id,
-- qb_line_id; NULLs distinct) can never collide with or resurrect children.
--
-- Idempotent. Run AFTER Publish only if Publish did not already apply the
-- equivalent diff; every statement is guarded. No BEGIN/COMMIT (psql -1).

ALTER TABLE staged_payments ALTER COLUMN qb_entity_id DROP NOT NULL;

ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS split_parent_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staged_payments_split_parent_id_staged_payments_id_fk'
  ) THEN
    ALTER TABLE staged_payments
      ADD CONSTRAINT staged_payments_split_parent_id_staged_payments_id_fk
      FOREIGN KEY (split_parent_id) REFERENCES staged_payments(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staged_payments_split_child_shape_chk'
  ) THEN
    ALTER TABLE staged_payments
      ADD CONSTRAINT staged_payments_split_child_shape_chk
      CHECK ((split_parent_id IS NULL) = (qb_entity_id IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS staged_payments_split_parent_id_idx
  ON staged_payments (split_parent_id)
  WHERE split_parent_id IS NOT NULL;
