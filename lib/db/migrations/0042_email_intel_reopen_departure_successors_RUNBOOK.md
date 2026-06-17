# Runbook 0042 — Re-open two auto-dismissed departure auto-replies

## What this does

Re-opens exactly two production `email_proposals` rows that the old
email-intelligence prompt auto-dismissed even though each names a brand-new
successor / point of contact who isn't in the CRM yet:

| id                      | sender                  | successor to surface                              |
| ----------------------- | ----------------------- | ------------------------------------------------- |
| `pd2R6s9KnM6YZ6DOGWS0z` | pradeep@rippleworks.org | Lindsay Blodgett (lindsay@rippleworks.org)        |
| `nIP74ptr9FQpq7p9Dn7ae` | shalini@edforwarddc.org | Margie Yeager, Managing Partner (margie@edforwarddc.org) |

It sets `status` back to `pending` and clears `actions_analyzed_at` +
`actions_error` (plus `resolved_at` / `reviewer_note` / `proposed_actions`) so
the **published, improved** prompt re-runs on them.

## Why it's needed

The fix lives in code (`buildDefaultSystemPrompt` in
`artifacts/api-server/src/lib/proposeActions.ts`) and ships via the normal
Publish flow. But re-analysis never revisits rows already in `status='ignored'`,
so without this file the two rows stay buried. The agent cannot write to prod,
so a human applies this after publish.

## Order of operations

1. **Publish first.** The improved prompt must be live in prod before you run
   this. If you run it before publish, the OLD prompt re-runs and may
   auto-dismiss the rows again.
2. Apply the SQL:
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0042_email_intel_reopen_departure_successors.sql
   ```
3. Trigger re-analysis (pick one):
   - **Wait** for the scheduled fresh-analysis sweep (off-hours America/Chicago)
     — it picks up rows with `actions_analyzed_at IS NULL` automatically, or
   - **Manual Retry**: open Email intelligence → "Moved (auto-reply)" tab, find
     each row, click Retry. (Retry is owner-scoped to the mailbox the proposal
     belongs to, so retry from the correct fundraiser's session.)

## Verification

Immediately after the SQL:
```sql
SELECT id, status, actions_analyzed_at, actions_error
FROM email_proposals
WHERE id IN ('pd2R6s9KnM6YZ6DOGWS0z', 'nIP74ptr9FQpq7p9Dn7ae');
-- expect: status='pending', actions_analyzed_at IS NULL, actions_error IS NULL
```

After the sweep / Retry, each row should carry a `create_person_with_per`
action proposing the successor (Lindsay / Margie) attached to the existing org
(RippleWorks / Ed Forward DC), and appear in the review queue.

## Safety / idempotency

Scoped to the two ids AND guarded on `status='ignored' AND reviewer_note LIKE
'Auto-suppressed%'`. A second run after the rows have been re-surfaced (or after
a human acts on them) is a no-op — it never clobbers human review work.
