-- 0266: QBO deposit-attachment evidence and Wildflower Updates retirement.
-- Idempotent. Apply with:
-- psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0266_feedback_queue_bundle.sql

CREATE TABLE IF NOT EXISTS quickbooks_deposit_attachments (
  id text PRIMARY KEY,
  realm_id text NOT NULL,
  qb_attachable_id text NOT NULL,
  qb_deposit_id text NOT NULL,
  file_name text,
  content_type text,
  note text,
  qb_updated_at timestamptz,
  extraction_status text NOT NULL DEFAULT 'pending',
  components jsonb,
  extraction_error text,
  extracted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qbo_deposit_attachments_status_ck
    CHECK (extraction_status IN ('pending', 'extracted', 'ignored', 'error')),
  CONSTRAINT qbo_deposit_attachments_source_uq
    UNIQUE (realm_id, qb_attachable_id, qb_deposit_id)
);

CREATE INDEX IF NOT EXISTS qbo_deposit_attachments_deposit_idx
  ON quickbooks_deposit_attachments (realm_id, qb_deposit_id);

-- The feature no longer emits or displays these proposals. Preserve them as
-- review history while removing them from the pending workflow.
UPDATE email_proposals
SET
  status = 'ignored',
  resolved_at = COALESCE(resolved_at, now()),
  reviewer_note = left(
    COALESCE(NULLIF(reviewer_note, '') || ' | ', '') ||
    'Retired with the Wildflower Updates workflow',
    500
  ),
  updated_at = now()
WHERE kind = 'wildflower_update'
  AND status = 'pending'
  AND COALESCE(reviewer_note, '') NOT LIKE '%Retired with the Wildflower Updates workflow%';
