-- Cached AI interpretation of the Gmail and Calendar evidence for one trip visit.
-- Gmail and Google Calendar remain the source of truth; these fields record the
-- most recent user-requested review so the result survives a page refresh.

ALTER TABLE trip_visit_candidates
  ADD COLUMN IF NOT EXISTS evidence_status text,
  ADD COLUMN IF NOT EXISTS evidence_summary text,
  ADD COLUMN IF NOT EXISTS evidence_confirmed_time text,
  ADD COLUMN IF NOT EXISTS evidence_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS evidence_reviewed_at timestamptz;

ALTER TABLE trip_visit_candidates
  DROP CONSTRAINT IF EXISTS trip_visit_candidates_evidence_status_check;

ALTER TABLE trip_visit_candidates
  ADD CONSTRAINT trip_visit_candidates_evidence_status_check
  CHECK (
    evidence_status IS NULL OR
    evidence_status IN ('not_invited', 'invited', 'responded', 'confirmed', 'bounced')
  );
