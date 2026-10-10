-- Additive; human-run on production after review. No production import performed.
ALTER TABLE conference_import_batches ADD COLUMN IF NOT EXISTS source_document_hash text;
ALTER TABLE conference_import_batches ADD COLUMN IF NOT EXISTS source_mapping jsonb;
ALTER TABLE conference_import_rows ADD COLUMN IF NOT EXISTS raw_title text;
ALTER TABLE conference_import_rows ADD COLUMN IF NOT EXISTS raw_cells jsonb;
ALTER TABLE conference_import_rows ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE conference_import_rows ADD COLUMN IF NOT EXISTS match_confidence text;
ALTER TABLE conference_import_rows ADD COLUMN IF NOT EXISTS matched_organization_id text REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE conference_import_rows ADD COLUMN IF NOT EXISTS candidate_person_ids text[];
ALTER TABLE conference_import_rows ADD COLUMN IF NOT EXISTS review_error text;
ALTER TABLE conference_import_rows ADD COLUMN IF NOT EXISTS foundation_evidence text;
ALTER TABLE conference_attendance ADD COLUMN IF NOT EXISTS registration_listed boolean NOT NULL DEFAULT false;
-- Existing confirmed attendance is retained; historical imports are not reinterpreted.
