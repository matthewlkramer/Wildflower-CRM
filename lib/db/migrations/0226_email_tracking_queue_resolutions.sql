-- Idempotent resolution state for the actionable email-tracking queues.
CREATE TABLE IF NOT EXISTS email_tracking_resolutions (
  id text PRIMARY KEY,
  queue_type text NOT NULL,
  source_id text NOT NULL,
  mailbox_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resolved_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  resolved_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_tracking_resolutions_queue_source_uq
  ON email_tracking_resolutions(queue_type, source_id);

CREATE INDEX IF NOT EXISTS email_tracking_resolutions_mailbox_idx
  ON email_tracking_resolutions(mailbox_user_id);