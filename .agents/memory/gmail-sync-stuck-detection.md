---
name: Gmail sync stall detection
description: How stuck Gmail mailboxes are detected and surfaced to admins
---
The Gmail sync worker tracks a per-mailbox consecutive no-forward-progress
counter so a wedged mailbox surfaces to an admin before a user notices missing
email.

**Rule:** the counter increments whenever a sync run finishes with errors (its
pagination cursor is deliberately held instead of advanced) OR the run throws.
Any clean run resets it to 0, including a quiet idle mailbox with no new mail
(errors == 0). A deliberate re-bootstrap on expired history also resets it.

**Why:** a deleted message once pinned a mailbox's cursor forever, and relying
on someone reading logs is fragile. Basing the counter on errors>0 (which
already implies the cursor was held) is what keeps healthy idle inboxes from
false-positiving — the key acceptance criterion. Threshold is deliberately
generous (≈ >1h of business-hours failures) to ride out brief Gmail blips.

**How to apply:** when touching sync stall logic, keep the increment/reset at
the worker's terminal cursor writes and keep the "stuck" boolean derived from a
single shared threshold constant, not duplicated per call site. The shared
admin sync-status shape carries the counter + stuck flag for both Gmail and
Calendar, but Calendar isn't tracked yet (reports healthy) — extend it
symmetrically rather than forking the contract.

**Two independent "stuck" axes in the admin panel — don't conflate them:**
1. `stuck` (incremental stall) = `noProgressRuns >= STUCK_NO_PROGRESS_THRESHOLD`,
   Gmail-only. Catches a wedged cursor on an already-bootstrapped mailbox.
2. `bootstrapStuck` (initial-sync stall) = bootstrap NOT completed AND
   (noProgressRuns past threshold OR the state row's `updated_at`/`last_synced_at`
   is stale > ~24h, falling back to `granted_at` for a grant that never ran).
   Computed in the GET `/admin/google-sync` route (display-only, not persisted),
   for BOTH Gmail and Calendar. This is the "initial sync in progress stuck for
   weeks" case — the healthy `bootstrapInProgress` flag alone never says whether
   it's advancing. Recovery is just "Sync now" (the resync route), which resumes
   bootstrap from its page token.

**Panel layout invariant:** ONE row per user. `google_oauth_tokens`,
`email_sync_state`, `calendar_sync_state` are all PK'd on `user_id`, so the
admin route's join yields exactly one row; Gmail/Calendar are columns, never
separate rows. (Earlier two-rows-per-person reports were the old split layout.)
"Resync now" was renamed to "Sync now".
