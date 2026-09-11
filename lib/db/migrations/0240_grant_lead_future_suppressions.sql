-- Durable, reviewer-created suppression rules for future grant-lead ingestion.
-- Existing archived leads remain untouched and available as provenance.

CREATE TABLE IF NOT EXISTS grant_lead_suppressions (
  id text PRIMARY KEY,
  scope text NOT NULL CONSTRAINT grant_lead_suppressions_scope_check
    CHECK (scope IN ('program', 'funder')),
  normalized_value text NOT NULL,
  display_value text NOT NULL,
  source_lead_id text REFERENCES grant_leads(id) ON DELETE SET NULL,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grant_lead_suppressions_scope_value_uq
    UNIQUE (scope, normalized_value)
);

CREATE INDEX IF NOT EXISTS grant_lead_suppressions_source_lead_id_idx
  ON grant_lead_suppressions(source_lead_id);
