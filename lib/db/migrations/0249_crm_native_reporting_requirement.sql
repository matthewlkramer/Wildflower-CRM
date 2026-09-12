-- Replace the coding-form staging table as the authority for whether an
-- opportunity/award requires donor reporting. This is a live CRM workflow
-- field, so future gifts can be validated and exported without a coding form.

ALTER TABLE opportunities_and_pledges
  ADD COLUMN IF NOT EXISTS reporting_required boolean;
