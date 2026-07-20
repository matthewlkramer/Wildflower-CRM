-- Migration 0142 (renumbered from 0140 on 2026-07-20 to resolve a triple-0140
-- numbering collision; already applied to prod under the old name — re-running
-- is a no-op).
--
-- runbook: apply after the code deploy that adds the overrides column to the
-- Drizzle schema (codingFormRows.ts). Safe to re-run (IF NOT EXISTS guard).
--
-- psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--   -f lib/db/migrations/0142_add_coding_form_row_overrides.sql

ALTER TABLE coding_form_rows
  ADD COLUMN IF NOT EXISTS overrides jsonb NOT NULL DEFAULT '{}';
