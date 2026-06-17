-- Migration 0042: Re-open two auto-dismissed departure auto-replies so the
-- improved email-intelligence prompt can surface their named successors.
--
-- WHY: The email-intelligence AI used to auto-dismiss (status -> 'ignored')
-- departure / "I've moved" auto-replies whenever the SUBJECT person needed no
-- change or wasn't matched to a CRM person -- even when the email named a
-- brand-new successor / point of contact who isn't in the CRM yet. Two real
-- production cases lost genuinely useful signal:
--   - pd2R6s9KnM6YZ6DOGWS0z  Pradeep @ rippleworks.org  -> names successor
--                            "Lindsay Blodgett, lindsay@rippleworks.org"
--   - nIP74ptr9FQpq7p9Dn7ae  Shalini @ edforwarddc.org  -> names successor
--                            "Margie Yeager, Managing Partner, margie@edforwarddc.org"
-- The code default prompt (buildDefaultSystemPrompt) has been fixed to keep
-- such proposals visible with an add-new-contact action. But re-analysis NEVER
-- revisits already-'ignored' rows, so these two stay buried in prod. This file
-- re-opens exactly those two rows and clears the analysis sentinels so the
-- published improved prompt re-runs on them -- via the scheduled fresh-analysis
-- sweep (rows with actions_analyzed_at IS NULL) or a manual Retry -- and
-- surfaces Lindsay and Margie in the review queue.
--
-- ORDER: run this AFTER the improved prompt is published. If you run it before
-- publish, the OLD prompt re-runs and may auto-dismiss them again.
--
-- SAFE + IDEMPOTENT: scoped to exactly the two record ids AND guarded to only
-- touch rows still auto-dismissed (status='ignored' AND the auto-suppression
-- reviewer note). So:
--   * a second run after the sweep has re-surfaced them is a no-op (status is
--     no longer 'ignored'),
--   * it never clobbers a row a human has since accepted / rejected / annotated.
-- It sets status -> 'pending', clears resolved_at / reviewer_note, and resets
-- actions_analyzed_at + actions_error to NULL (the fresh-analysis claim guard).
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0042_email_intel_reopen_departure_successors.sql

UPDATE email_proposals
SET status              = 'pending',
    resolved_at         = NULL,
    resolved_by_user_id = NULL,
    reviewer_note       = NULL,
    actions_analyzed_at = NULL,
    actions_error       = NULL,
    proposed_actions    = '[]'::jsonb,
    updated_at          = now()
WHERE id IN ('pd2R6s9KnM6YZ6DOGWS0z', 'nIP74ptr9FQpq7p9Dn7ae')
  AND status = 'ignored'
  AND reviewer_note LIKE 'Auto-suppressed%';

-- Verification (run after applying):
--   SELECT id, status, actions_analyzed_at, actions_error
--   FROM email_proposals
--   WHERE id IN ('pd2R6s9KnM6YZ6DOGWS0z', 'nIP74ptr9FQpq7p9Dn7ae');
--   -- expect: status='pending', actions_analyzed_at=NULL, actions_error=NULL
--   -- (until the fresh-analysis sweep / a manual Retry repopulates them).
