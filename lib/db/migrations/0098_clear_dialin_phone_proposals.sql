-- Migration 0098: clear already-surfaced Zoom / Google Meet dial-in numbers
--                 that leaked into the reviewer queue as "add phone" proposals.
--
-- WHY:
--   The email-intelligence signature parser previously closed a Zoom / Google
--   Meet dial-in block one line too early: it only kept skipping follow-on
--   dial-in lines that START with a digit or "+". Real dial-in lines are almost
--   always label-prefixed — "US: +1 646 931 3860", "(US) +1 302-317-2902",
--   "New York, NY +1 …" — so the block closed early and the access number leaked
--   through as the sender's parsed phone. The AI then proposed it as `set_phone`
--   even while its own `reason` text admits the number came from a dial-in line
--   (e.g. Tanya Beja "+1 646-931-3860 appears in Zoom dial-in line",
--   Brandon Levin "+1 302-317-2902 found in Google Meet dial-in details").
--
--   The parser gap is fixed in code (artifacts/api-server/src/lib/intelDetectors.ts)
--   so NEW syncs no longer produce these. This file cleans up the proposals that
--   already sit in reviewers' Signature-updates queue with a dial-in `set_phone`.
--
-- WHAT THIS FILE DOES (DATA-only, idempotent):
--   For every still-PENDING `signature_update` proposal whose `proposed_actions`
--   contains a `set_phone` whose `reason` names a conference / meeting dial-in
--   context (Zoom / Google Meet / Teams / Webex / dial-in / one-tap / join by
--   phone / conference / Meeting ID / passcode / PIN):
--     1. Strip that dial-in `set_phone` action out of `proposed_actions`
--        (leaving any legitimate title/company/email actions untouched).
--     2. If that empties `proposed_actions`, mark the whole proposal `ignored`
--        with a reviewer note so it leaves the queue (the dial-in phone was its
--        only content). Proposals that still carry a real action stay pending.
--
--   Nothing is deleted; no CRM phone is written or removed (this is signal
--   cleanup only — the actual phone mutation only ever happens on human accept).
--
-- IDEMPOTENCY / SAFETY:
--   * Re-running is a no-op: once the dial-in `set_phone` actions are stripped,
--     the WHERE / EXISTS guard matches zero rows, so no proposal is touched and
--     the reviewer note is never appended twice.
--   * Scoped to `status = 'pending'` — an already accepted/rejected/ignored row
--     is left exactly as the reviewer left it.
--   * Conservative match: only `set_phone` actions whose `reason` explicitly
--     references a meeting/dial-in context are removed. A genuine personal phone
--     ("Mobile: …") has no such reason and is preserved. Reviewers can still
--     reject any straggler individually.
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0098_clear_dialin_phone_proposals.sql
--
-- Run with `-1` (psql wraps the whole file in ONE transaction). Do NOT add an
-- internal BEGIN/COMMIT — `-1` already provides the single-transaction guarantee.

-- ─── 1. Strip dial-in set_phone actions + auto-ignore emptied proposals ─────
-- Dial-in reason matcher (Postgres ARE; `\y` = word boundary, `\s` = whitespace).
WITH affected AS (
  SELECT
    p.id,
    COALESCE(
      (
        SELECT jsonb_agg(elem)
        FROM jsonb_array_elements(p.proposed_actions) AS elem
        WHERE NOT (
          elem->>'type' = 'set_phone'
          AND elem->>'reason' ~* '(zoom|google\s*meet|microsoft\s*teams|webex|dial[-\s]?in|dial by your|one[-\s]?tap|join by phone|conference|meeting\s*id|passcode|\ypin\y|access code)'
        )
      ),
      '[]'::jsonb
    ) AS cleaned
  FROM email_proposals p
  WHERE p.kind = 'signature_update'
    AND p.status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p.proposed_actions) AS elem
      WHERE elem->>'type' = 'set_phone'
        AND elem->>'reason' ~* '(zoom|google\s*meet|microsoft\s*teams|webex|dial[-\s]?in|dial by your|one[-\s]?tap|join by phone|conference|meeting\s*id|passcode|\ypin\y|access code)'
    )
)
UPDATE email_proposals p
SET
  proposed_actions = a.cleaned,
  status = CASE WHEN a.cleaned = '[]'::jsonb THEN 'ignored' ELSE p.status END,
  resolved_at = CASE WHEN a.cleaned = '[]'::jsonb THEN now() ELSE p.resolved_at END,
  reviewer_note = CASE
    WHEN a.cleaned = '[]'::jsonb
    THEN left(
      COALESCE(NULLIF(p.reviewer_note, '') || ' | ', '') ||
      'Flagged inaccurate: dial-in / meeting access number, not a personal phone',
      500
    )
    ELSE p.reviewer_note
  END,
  updated_at = now()
FROM affected a
WHERE p.id = a.id;

-- ─── 2. Operator report (non-aborting) ─────────────────────────────────────
DO $$
DECLARE
  n_dialin int;
BEGIN
  -- After the UPDATE this should read 0 (every dial-in set_phone was stripped).
  SELECT count(*) INTO n_dialin
  FROM email_proposals p
  WHERE p.kind = 'signature_update'
    AND p.status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p.proposed_actions) AS elem
      WHERE elem->>'type' = 'set_phone'
        AND elem->>'reason' ~* '(zoom|google\s*meet|microsoft\s*teams|webex|dial[-\s]?in|dial by your|one[-\s]?tap|join by phone|conference|meeting\s*id|passcode|\ypin\y|access code)'
    );
  RAISE NOTICE '0098: pending signature_update proposals still carrying a dial-in set_phone = % (expect 0)', n_dialin;
END $$;
