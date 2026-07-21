-- Migration 0146: Backfill + drop retired transitional gift/org columns (Task #757)
--
-- Retires three transitional columns whose facts the current architecture
-- answers elsewhere:
--   - gifts_and_payments.final_amount_source     — amount provenance is derived
--     from the counted payment_applications ledger; the amount-authority
--     read-flip is complete and no code reads/writes this column.
--   - gifts_and_payments.original_human_crm_amount — transitional sibling;
--     no code reads/writes it.
--   - organizations.payment_intermediary_id      — superseded by the
--     donor_payment_intermediaries join table (the logged source of truth).
--     Step 1 idempotently backfills any remaining non-null values there
--     before the drop. Per-gift gifts_and_payments.payment_intermediary_id
--     (the transaction-level record) is NOT touched.
--
-- Also drops:
--   - the gift_final_amount_source enum type (only user was the dropped column)
--   - organizations_payment_intermediary_id_idx (index on the dropped column)
--
-- SAFE TO RE-RUN (IF EXISTS everywhere; the backfill is ON CONFLICT DO NOTHING
-- and a no-op once the source column is gone).
-- Apply AFTER the new api-server build is deployed (the deployed build no
-- longer reads, writes, or echoes any of these columns).
--
-- Run against prod:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0146_drop_transitional_gift_org_columns.sql

-- ── Step 1: Backfill org-level payment intermediary links into
--            donor_payment_intermediaries (idempotent; skipped if the source
--            column is already dropped) ─────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations'
      AND column_name = 'payment_intermediary_id'
  ) THEN
    INSERT INTO donor_payment_intermediaries
      (id, payment_intermediary_id, organization_id, notes, created_at, updated_at)
    SELECT
      'dpibf_' || o.id,                -- deterministic id (idempotent re-run)
      o.payment_intermediary_id,
      o.id,
      'Backfilled from organizations.payment_intermediary_id (migration 0146)',
      NOW(), NOW()
    FROM organizations o
    JOIN payment_intermediaries pi ON pi.id = o.payment_intermediary_id
    WHERE o.payment_intermediary_id IS NOT NULL
    ON CONFLICT (organization_id, payment_intermediary_id)
      WHERE organization_id IS NOT NULL
      DO NOTHING;
  END IF;
END $$;

-- ── Step 2: Drop the retired columns / index / enum type ────────────────────
DROP INDEX IF EXISTS organizations_payment_intermediary_id_idx;

ALTER TABLE organizations
  DROP COLUMN IF EXISTS payment_intermediary_id;

ALTER TABLE gifts_and_payments
  DROP COLUMN IF EXISTS final_amount_source,
  DROP COLUMN IF EXISTS original_human_crm_amount;

-- The enum type's only column is gone; safe to drop the type itself.
DROP TYPE IF EXISTS gift_final_amount_source;
