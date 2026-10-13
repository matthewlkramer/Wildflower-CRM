-- User-authorized feedback closeout, 2026-10-13. No feature changes.
-- Guarded by open status; preserves existing notes and is safe to rerun.
WITH verified(id, evidence) AS (VALUES
  ('feedback__ASHhrGrmj997oqbCWBTW', 'Reviewed 2026-10-13: PR #180 shipped the giving-card rule: show recorded payment amounts when present, otherwise the pledge amount; do not add both.'),
  ('feedback_YdWL216bXKaufm52WG1QL', 'Reviewed 2026-10-13: PR #180 derives unknown email validity from inbound exchanges while preserving explicit invalidation. Live Emma record has a valid preferred email with 24 inbound messages; the preserved Bentonville address is Past.'),
  ('feedback_cxo0v2wGwjNK_YkrtFHj2', 'Reviewed 2026-10-13: PR #180 derives last contact from imported baseline, logged interactions, Gmail, and Calendar. Live John Petry derived last-contact date is 2025-12-01.'),
  ('feedback_l_lKm88nqDHA8eVUT-9lt', 'Reviewed 2026-10-13: published frontend contains Data cleanup and integrity, per-user browser dashboard preferences, Past meeting follow-ups, and Gifts needing thank-yous from PR #182. Missing customization for the three bottom navigation cards is tracked separately.')
)
UPDATE app_feedback AS f
SET status = 'resolved',
    admin_notes = concat_ws(E'\n\n', NULLIF(f.admin_notes, ''), v.evidence),
    resolved_by_user_id = 'usr_matthew_kramer',
    resolved_at = NOW(),
    updated_at = NOW()
FROM verified AS v
WHERE f.id = v.id AND f.status = 'open'
  AND EXISTS (SELECT 1 FROM users WHERE id = 'usr_matthew_kramer')
RETURNING f.id, f.status;
