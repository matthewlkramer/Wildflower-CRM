# Runbook — 0098 Clear leaked Zoom / Google Meet dial-in "add phone" proposals

## What this does

DATA-only cleanup of the email-intelligence reviewer queue. It removes the
`set_phone` action from every still-**pending** `signature_update` proposal whose
action `reason` names a conference / meeting dial-in context (Zoom / Google Meet /
Teams / Webex, "one tap", "join by phone", "dial-in", "Meeting ID", "passcode",
"PIN", etc.). If stripping that action leaves the proposal with no actions at all
(the dial-in phone was its only content), the proposal is marked `ignored` with a
reviewer note so it leaves the queue.

Nothing is deleted and no CRM phone is written or removed — the real phone
mutation only ever happens when a human accepts a proposal, so this is pure
signal cleanup.

## Why it is needed

The signature parser closed a Zoom / Google Meet dial-in block one line too
early: it only kept skipping follow-on dial-in lines that START with a digit or
`+`, but real dial-in lines are label-prefixed (`US: +1 646 931 3860`,
`(US) +1 302-317-2902`, `New York, NY +1 …`). The access number leaked through as
the sender's parsed phone and the AI proposed it as `set_phone` — even while its
own reason text admitted the dial-in origin (Tanya Beja, Brandon Levin, etc.).

The parser gap is fixed in code (`artifacts/api-server/src/lib/intelDetectors.ts`)
plus a defensive AI-prompt backstop, so **new** syncs no longer create these. This
file only cleans the rows already sitting in the queue.

## Why it is safe

- Scoped to `status = 'pending'` — accepted/rejected/ignored rows are untouched.
- Conservative match: only `set_phone` actions whose `reason` explicitly
  references a meeting/dial-in context are removed. A genuine personal phone
  (`Mobile: …`) carries no such reason and is preserved; other actions
  (title/company/email) on the same proposal are preserved.
- Idempotent: re-running matches zero rows once the actions are stripped, so the
  reviewer note is never appended twice.

## Pre-check (read-only, run against prod first)

```sql
SELECT count(*)
FROM email_proposals p
WHERE p.kind = 'signature_update'
  AND p.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p.proposed_actions) AS elem
    WHERE elem->>'type' = 'set_phone'
      AND elem->>'reason' ~* '(zoom|google\s*meet|microsoft\s*teams|webex|dial[-\s]?in|dial by your|one[-\s]?tap|join by phone|conference|meeting\s*id|passcode|\ypin\y|access code)'
  );
```

## Apply

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0098_clear_dialin_phone_proposals.sql
```

The file emits a `RAISE NOTICE` reporting the remaining dial-in `set_phone` count,
which should be `0` after it runs. Re-run the pre-check query to confirm.

## Rollback

None required — the change is additive/curative and non-destructive. If a proposal
was wrongly ignored, a reviewer can reopen it or the next sync re-surfaces a fresh
signal.
