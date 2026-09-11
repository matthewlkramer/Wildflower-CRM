---
status: current-status
last_verified: 2026-09-10
---

# Feedback implementation proposals

The in-app feedback queue stores user reports in `app_feedback`. Each feedback
item has at most one durable `app_feedback_proposals` row containing the current
AI-authored implementation proposal and its human revision trail.

## Authority and context

The feedback record and later reviewer guidance are authoritative for the
desired outcome. The generator receives:

- the feedback category and message;
- page URL, path, and title;
- reproduction-relevant captured state (viewport, scroll position, active
  tabs/controls, control values, and visible test IDs);
- a curated, versioned architecture summary and a deterministic page-to-area
  map.

The browser fingerprint and screenshot binary are not sent to the model. The
screenshot remains available to the human reviewer in the private feedback
queue. The model is told that it has not read source code and must not invent
exact files or claim that a change has been made.

## Lifecycle

New feedback creates a proposal row in `queued` state without waiting for AI.
An in-process worker atomically claims it as `generating`, then stores either a
structured `ready` proposal or an `error`. A bounded scheduler also backfills
older feedback and re-queues generations interrupted for more than fifteen
minutes. AI calls use the shared proposal concurrency and rate-limit retry
controls.

`Modify proposal` accepts plain-English reviewer guidance. Guidance is appended
to the audit trail, the revision number increments, and the complete proposal
is regenerated. A proposal already handed off for implementation cannot be
silently revised.

## Implementation authority and handoff

The running CRM has no trusted channel to edit or publish its own GitHub source.
`Start implementation` therefore performs an explicit human-gated handoff: it
records the approving owner, marks the feedback item `in_progress`, and copies
the proposal's self-contained coding-agent brief for Codex or Replit. The
confirmation dialog states this boundary. Code review, tests, migrations,
publishing, and any production data writes remain separate steps.

All administrators may read and modify proposals. Starting implementation is a
separate server-enforced capability: the authenticated user must be an active
administrator whose CRM user ID exactly matches `FEEDBACK_IMPLEMENTER_USER_ID`.
The application fails closed when that environment variable is absent or blank,
and the frontend only displays the action when the API reports that the current
viewer is authorized. For the current single-owner policy, production should
set the value to `usr_matthew_kramer`.

This binds the CRM approval to the owner's authenticated CRM identity. The CRM
does not receive or impersonate a Chat/Codex login; actual repository work still
runs in a Codex session owned by that account.

Migration and verification steps are in
`lib/db/migrations/0242_app_feedback_proposals_RUNBOOK.md`.
