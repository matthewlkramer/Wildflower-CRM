---
name: Email-intel "propose alternative" + reviewer-note append
description: Durable rules for the reviewer-guided AI re-run path on email proposals
---

# Propose-alternative re-run + reviewer-note append

A reviewer can submit a plain-English correction ("Propose alternative") that
re-runs the per-proposal AI with that guidance; the suggested actions refresh in
place.

**Rule 1 — a reviewer-driven re-run must keep the proposal in the queue.** The
normal analysis path auto-ignores a proposal when the model returns
suppress=true with no actions. A revise/re-run must NOT: the reviewer explicitly
asked to re-run it and expects it to stay pending. Enforced by a
`disableAutoSuppress` flag on the shared analysis function, set only by the
revise path.
**Why:** without it, "propose alternative" could silently delete the item the
reviewer is actively working on.

**Rule 2 — reviewer feedback is accumulative, never overwritten.** Accept,
reject, AND revise all *append* to the reviewer-note field; they never replace
it.
**Why:** a reviewer may leave several corrections before a final verdict; each is
prompt-tuning signal the admin prompt-mining reads back out. Overwriting discards
earlier corrections.

**Rule 3 — guidance goes in the per-proposal USER prompt, not the system
prompt.** It does not touch the admin-editable system prompt.

**How to apply:** the revise path is owner-scoped + pending-only (404 vs 409 like
retry), resets the error + analyzed-at fields, and runs through the same AI
concurrency limiter + rate-limit-retry wrapper as the normal pipeline. No changes
to accept/dismiss apply/rollback logic.
