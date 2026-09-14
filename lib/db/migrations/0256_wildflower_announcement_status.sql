-- Additive development migration for announcement-style Wildflower updates.
ALTER TYPE "wildflower_update_status"
  ADD VALUE IF NOT EXISTS 'announcement';