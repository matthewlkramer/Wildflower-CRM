-- Rolling projected-close timing. The effective calendar date is deliberately
-- derived at read time; existing specific dates remain unchanged.
ALTER TABLE opportunities_and_pledges
  ADD COLUMN IF NOT EXISTS projected_close_months_out integer;

ALTER TABLE opportunities_and_pledges
  DROP CONSTRAINT IF EXISTS opportunities_and_pledges_projected_close_months_out_positive;

ALTER TABLE opportunities_and_pledges
  ADD CONSTRAINT opportunities_and_pledges_projected_close_months_out_positive
  CHECK (projected_close_months_out IS NULL OR projected_close_months_out > 0);