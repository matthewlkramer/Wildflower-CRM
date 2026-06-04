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
