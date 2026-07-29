-- Private in-app product feedback queue. Screenshots are stored in the
-- existing authenticated object store; only their relative URL is persisted.

CREATE TABLE IF NOT EXISTS app_feedback (
  id text PRIMARY KEY,
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category text NOT NULL DEFAULT 'bug',
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  page_url text NOT NULL,
  page_path text NOT NULL,
  page_title text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  screenshot_url text,
  screenshot_filename text,
  screenshot_status text NOT NULL DEFAULT 'skipped',
  screenshot_error text,
  admin_notes text,
  resolved_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_feedback_category_ck
    CHECK (category IN ('bug', 'question', 'suggestion', 'other')),
  CONSTRAINT app_feedback_status_ck
    CHECK (status IN ('open', 'in_progress', 'resolved', 'dismissed')),
  CONSTRAINT app_feedback_screenshot_status_ck
    CHECK (screenshot_status IN ('captured', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS app_feedback_status_created_idx
  ON app_feedback(status, created_at);
CREATE INDEX IF NOT EXISTS app_feedback_creator_created_idx
  ON app_feedback(created_by_user_id, created_at);
CREATE INDEX IF NOT EXISTS app_feedback_created_idx
  ON app_feedback(created_at);
