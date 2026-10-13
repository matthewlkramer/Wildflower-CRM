-- Apply before publishing the API; additive and idempotent. No records removed.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS archived_at timestamptz;
