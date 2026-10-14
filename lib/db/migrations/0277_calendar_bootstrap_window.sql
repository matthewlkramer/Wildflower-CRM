-- Apply before publication. Legacy unbounded page cursors are restarted by
-- the worker only when this bound is absent. Imported events are preserved.
ALTER TABLE calendar_sync_state ADD COLUMN IF NOT EXISTS bootstrap_time_max timestamptz;
