-- User-authorized queue progress for the twelve reviewed October reports.
-- Metadata only. Idempotent; terminal feedback statuses are never reopened.
WITH implemented(id) AS (VALUES
  ('feedback_3kkR-09BWsfmLloMiLcq5'),
  ('feedback_bCr-rotMNt-Tqga2NyzWf'),
  ('feedback_f-ppddjNpZhRUQ-S3nC4h'),
  ('feedback_ClaaOcfkSTo-8yELrI5fx'),
  ('feedback_BuTXFwgYN8ALNLhQqdF9z'),
  ('feedback_4NJr3_PFXiJjq1L47TWX7'),
  ('feedback_YNvMp8XYbLvba-vHGVQdx'),
  ('feedback_tLflB-wOx6N2SF09FqbPw'),
  ('feedback_bdPLhsB0H41h6TLse0aPG'),
  ('feedback_uoTvcAlfp5-VB7OabqWb0'),
  ('feedback_Qt2XIg-4akaqg69dwDa3a'),
  ('feedback_swZG1dl8mvMBRecPBidKB')
)
UPDATE app_feedback AS f
SET status = 'in_progress',
    admin_notes = concat_ws(E'\n\n', NULLIF(f.admin_notes, ''),
      'Implementation delivered in draft PR #184: https://github.com/matthewlkramer/Wildflower-CRM/pull/184 . API/frontend suites, typecheck, codegen, builds, and synthetic browser checks passed. Awaiting migrations 0276/0277, publication, and the live checks in lib/db/migrations/0276_0277_feedback_RUNBOOK.md before resolution. The cloud AI provider rejected the configured credentials; verify deployed AI authentication separately.'),
    resolved_by_user_id = NULL,
    resolved_at = NULL,
    updated_at = NOW()
FROM implemented AS i
WHERE f.id = i.id AND f.status IN ('open', 'in_progress')
  AND COALESCE(f.admin_notes, '') NOT LIKE '%Implementation delivered in draft PR #184:%'
RETURNING f.id, f.status;
