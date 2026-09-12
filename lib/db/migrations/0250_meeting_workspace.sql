-- Apply in a transaction:
-- psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0250_meeting_workspace.sql

ALTER TABLE meeting_notes
  ADD COLUMN IF NOT EXISTS manual_notes text,
  ADD COLUMN IF NOT EXISTS artifacts jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN meeting_notes.manual_notes IS
  'Verbatim staff notes, kept separate from AI summaries and transcripts.';
COMMENT ON COLUMN meeting_notes.artifacts IS
  'Private meeting source files with metadata and OpenAI OCR/transcription text.';

-- Remove workflow requirements the team explicitly decided not to use.
UPDATE cleanup_queue
SET note = regexp_replace(
  regexp_replace(
    note,
    'assign Finance review, an owner, and a follow-up date',
    'complete Finance review',
    'gi'
  ),
  E'\\s*Owner and follow-up date: to be assigned\\.?',
  '',
  'gi'
),
updated_at = now()
WHERE target_type = 'work_item'
  AND reason_code = 'cleanup_project'
  AND (
    note ~* 'owner and follow-up date'
    OR note ~* 'assign Finance review, an owner, and a follow-up date'
  );
