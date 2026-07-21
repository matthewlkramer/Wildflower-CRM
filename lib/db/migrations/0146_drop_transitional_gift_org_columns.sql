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
--   - organizations_payment_intermediary_id_idx (index on the dropped column)
--   - gift_amount_allocation_review (table, with its indexes/FKs) — the
--     amount-review worklist of the RETIRED stamp/unstamp final-amount flow
--     (Task #757). Dead code: no OpenAPI path, no frontend reference, no server
--     route reads it; its only writer's only caller was an integration test.
--     Prod holds 0 rows (verified 2026-07-21); dev's 28 stale OPEN rows are
--     transient worklist debris from the retired flow, safe to drop.
--   - gift_final_amount_source enum type — its last dependent is the review
--     table above, so it is dropped immediately AFTER the table. (The first
--     prod apply failed at DROP TYPE because the table still used it; the -1
--     transaction rolled back atomically, so prod was left unchanged.)
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

-- ── Step 2: Drop the retired columns / index ─────────────────────────────────
DROP INDEX IF EXISTS organizations_payment_intermediary_id_idx;

ALTER TABLE organizations
  DROP COLUMN IF EXISTS payment_intermediary_id;

ALTER TABLE gifts_and_payments
  DROP COLUMN IF EXISTS final_amount_source,
  DROP COLUMN IF EXISTS original_human_crm_amount;

-- ── Step 3: Drop the dead review-table worklist, THEN its enum ───────────────
-- Order matters: gift_amount_allocation_review.source is the enum's last
-- dependent, so the table must go first or DROP TYPE fails (as the first prod
-- apply did). Indexes and FKs drop with the table.
DROP TABLE IF EXISTS gift_amount_allocation_review;

DROP TYPE IF EXISTS gift_final_amount_source;
