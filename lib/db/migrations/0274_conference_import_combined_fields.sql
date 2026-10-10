-- Additive combined-field evidence. Original text is never replaced by a split.
ALTER TABLE conference_import_rows ADD COLUMN IF NOT EXISTS raw_combined_title_organization text;
ALTER TABLE conference_import_rows ADD COLUMN IF NOT EXISTS proposed_title text;
ALTER TABLE conference_import_rows ADD COLUMN IF NOT EXISTS proposed_organization text;
ALTER TABLE conference_import_rows ADD COLUMN IF NOT EXISTS split_needs_review boolean;
ALTER TABLE conference_import_rows ADD COLUMN IF NOT EXISTS split_evidence text;
