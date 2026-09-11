-- AI-authored, human-reviewed implementation proposals for in-app feedback.
-- Safe to re-run. Existing feedback is backfilled by the application scheduler
-- after deploy; this migration only creates the durable proposal queue.
--
-- Production:
--   psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0242_app_feedback_proposals.sql

CREATE TABLE IF NOT EXISTS app_feedback_proposals (
  id text PRIMARY KEY,
  feedback_id text NOT NULL REFERENCES app_feedback(id) ON DELETE CASCADE,
  generation_status text NOT NULL DEFAULT 'queued',
  revision integer NOT NULL DEFAULT 1,
  context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposal jsonb,
  reviewer_guidance text,
  analyzed_at timestamp,
  model text,
  error text,
  implementation_requested_at timestamp,
  implementation_requested_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_feedback_proposals_generation_status_ck
    CHECK (generation_status IN ('queued', 'generating', 'ready', 'error')),
  CONSTRAINT app_feedback_proposals_revision_ck CHECK (revision >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_feedback_proposals_feedback_uq
  ON app_feedback_proposals(feedback_id);
CREATE INDEX IF NOT EXISTS app_feedback_proposals_generation_idx
  ON app_feedback_proposals(generation_status, updated_at);
CREATE INDEX IF NOT EXISTS app_feedback_proposals_implementation_idx
  ON app_feedback_proposals(implementation_requested_at);
