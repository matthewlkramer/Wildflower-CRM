-- Migration 0005: Rewrite verbal_commitment in saved-view filter state
--
-- saved_views.state is opaque page JSON ({filters, sort, columns}). Stage
-- filters store the raw enum value, so any saved view that filters on the old
-- `verbal_commitment` value would silently stop matching after the rename.
-- This rewrites the literal inside the JSON text representation.
--
-- ORDER: run alongside/after 0003. Safe to run before or after 0004.
--
-- Idempotent: after the rewrite no row contains the old literal, so a second
-- run matches nothing.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0005_saved_views_verbal_confirmation.sql

UPDATE saved_views
SET state = replace(state::text, 'verbal_commitment', 'verbal_confirmation')::jsonb,
    updated_at = now()
WHERE state::text LIKE '%verbal_commitment%';
