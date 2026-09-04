-- Stored AI-generated opportunity headlines for Grant Leads.
-- Additive and idempotent so it can be applied to development explicitly and
-- production through the normal publish/schema flow.
ALTER TABLE grant_leads
  ADD COLUMN IF NOT EXISTS ai_summary text,
  ADD COLUMN IF NOT EXISTS ai_model text,
  ADD COLUMN IF NOT EXISTS ai_summarized_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_summary_error text;
