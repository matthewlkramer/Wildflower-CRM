CREATE TABLE IF NOT EXISTS calendar_event_attendance (
  physical_event_key text NOT NULL,
  email_address text NOT NULL,
  absent boolean NOT NULL DEFAULT false,
  updated_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (physical_event_key, email_address)
);
