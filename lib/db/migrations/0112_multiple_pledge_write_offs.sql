-- 0112: allow multiple active write-off pledges per audited original.
--
-- The partial UNIQUE index enforced "at most one ACTIVE write-off child per
-- pledge". Partial write-offs are now legal and may accumulate over time (the
-- amount is user-chosen and capped at the remainder net of prior write-offs).
-- The replacement rule — at most one EDITABLE (open-FY) write-off at a time —
-- is enforced app-level inside the write-off route's locked transaction
-- (SELECT ... FOR UPDATE on the original pledge row), so the DB uniqueness is
-- replaced by a plain partial lookup index.
--
-- Idempotent: safe to re-run. Apply with
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0112_multiple_pledge_write_offs.sql
-- AFTER the code shipping the app-level guard has been published (never
-- before, or concurrent write-off requests lose their only backstop).

DROP INDEX IF EXISTS opportunities_and_pledges_active_write_off_uq;

CREATE INDEX IF NOT EXISTS opportunities_and_pledges_active_write_off_idx
  ON opportunities_and_pledges (write_off_of_pledge_id)
  WHERE write_off_of_pledge_id IS NOT NULL AND archived_at IS NULL;
