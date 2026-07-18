-- 0132: Add AI-reinterpretation columns to coding_form_rows.
--
-- One Zod-validated jsonb payload per staging row (normalized donor name,
-- parsed address, circle classification, junk/redundant-text flags,
-- reinterpreted report requirement) + provenance stamps. Deterministic code
-- reads EFFECTIVE values (AI ?? parsed ?? raw) through the single accessor in
-- artifacts/api-server/src/lib/codingFormEffective.ts. The re-runnable seed
-- never touches these columns.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS only; no data change; safe to re-run.
-- Apply (human, from repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0132_add_coding_form_ai_columns.sql

ALTER TABLE coding_form_rows
  ADD COLUMN IF NOT EXISTS ai_interpretation jsonb,
  ADD COLUMN IF NOT EXISTS ai_interpreted_at timestamp,
  ADD COLUMN IF NOT EXISTS ai_model text,
  ADD COLUMN IF NOT EXISTS ai_error text;
