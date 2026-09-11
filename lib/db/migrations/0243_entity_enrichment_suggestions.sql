-- 0243 — Durable, human-reviewed suggestions derived from existing CRM data.
--
-- Additive and safe to re-run. This creates the suggestion sidecar only; it
-- does not change any person or organization field and does not seed rows.
--
-- Apply from the repository root after the corresponding code is published:
-- psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0243_entity_enrichment_suggestions.sql

CREATE TABLE IF NOT EXISTS enrichment_suggestions (
  id text PRIMARY KEY,
  entity_type text NOT NULL
    CONSTRAINT enrichment_suggestions_entity_type_ck
    CHECK (entity_type IN ('person', 'organization')),
  entity_id text NOT NULL,
  field_name text NOT NULL,
  suggested_value jsonb NOT NULL,
  source_label text NOT NULL,
  source_detail text,
  status text NOT NULL DEFAULT 'pending'
    CONSTRAINT enrichment_suggestions_status_ck
    CHECK (status IN ('pending', 'accepted', 'dismissed')),
  resolved_at timestamp,
  resolved_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS enrichment_suggestions_pending_uq
  ON enrichment_suggestions(entity_type, entity_id, field_name)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS enrichment_suggestions_entity_idx
  ON enrichment_suggestions(entity_type, entity_id, status);

CREATE INDEX IF NOT EXISTS enrichment_suggestions_resolved_by_idx
  ON enrichment_suggestions(resolved_by_user_id);
