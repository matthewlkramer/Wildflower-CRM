---
name: task intelligence (AI next-step suggestions)
description: How the AI-suggested next-step task feature behaves on person/org detail pages.
---

# Task intelligence — AI-suggested next-step cultivation tasks

Modeled on email-intelligence: on-demand hybrid, one cached `pending`
suggestion per CRM entity (person OR org), surfaced inside the Tasks card on
detail pages. No new pages/dashboard cards.

## Auto-generate gating (the important rule)

GET `/task-proposals` must auto-generate (spend an AI call) ONLY on a **true
first view** — when NO proposal row of any status exists for the entity's
dedupeKey (`person:<id>` / `org:<id>`). Once a suggestion has been accepted or
dismissed, GET returns `{ data: null }` and must NOT silently regenerate.

**Why:** if GET regenerates whenever there's no pending row, then accepting a
suggestion immediately repopulates the block (it never "disappears") and burns a
fresh AI call on every page view.

**How to apply:** distinguish "first view" (no proposal of any status → generate)
from "return visit after resolve" (a resolved row exists, no pending → null).
A new suggestion only comes from an explicit POST `/task-proposals/refresh`.
This relies on the dedupe unique index being partial (`WHERE status =
'pending'`), so a new pending row can coexist with old resolved rows.

## Other invariants

- priority='low' entities are skipped — no row, no AI call; GET returns null.
- Generation never throws: errors / "no action warranted" are recorded on the
  row (`error` col); `analyzedAt IS NULL` means still generating.
- AI call resilience follows the shared pattern (aiProposalLimit +
  withRateLimitRetry + SDK maxRetries:0).
- Accept creates a real linked `tasks` row (inherits title/description/
  suggestedDueDate, links target person/org) inside a txn and flips proposal →
  accepted with acceptedTaskId pointer. Dismiss → dismissed + optional note.
- Client must invalidate BOTH the task-proposal query key and the tasks list key
  after accept so the new real task shows and the suggestion block clears.
- Any new table with target_person_id/target_organization_id under an XOR check
  + `onDelete: "set null"` MUST be added to the entity-merge fkRefs
  (mergeEntities.ts), or merging an entity nulls the FK and violates the XOR
  check, failing the merge txn. The merge-config inventory test asserts config
  fkRefs == every schema FK to people.id/organizations.id, so it catches a
  missed table — mirror the `email_proposals` entries.

## Rollout / automation (backfill + signal triggers + monthly refresh)

The automation layer reuses the SAME generation entry point as the on-demand
GET — there is ONE function (`runTaskSuggestion(entity, {trigger, mode})`) that
all callers funnel through; it delegates the actual AI call to the existing
`generateTaskProposal` (so aiProposalLimit + retry guardrails always apply).
Never add a second generation path.

- **Modes**: `ensure` (create only if NO proposal of any status — used by the
  one-time backfill; idempotent/resumable), `refresh-pending` (regenerate the
  existing pending row in place — monthly), `regenerate` (signal-triggered).
  All modes still respect the "never resurface a resolved suggestion" rule — a
  resolved (accepted/dismissed) entity is left alone unless an explicit refresh.
- **priority gating**: only explicit `'low'` is skipped; NULL priority = not low.
- **Single advisory lock** `(9002, 1)` is shared by BOTH the backfill and the
  monthly refresh so the two heavy sweeps can never overlap. Signal-triggered
  regenerations are continuous (not "runs") and do NOT take this lock or touch
  the run-state row.
- **Run-state** lives in singleton table `task_suggestion_state` (mirrors
  `media_ingest_state`); the monthly scheduler reads `lastRunFinishedAt` to
  enforce ~monthly throttle (MIN_DAYS_BETWEEN_RUNS=28, STALE_AFTER_DAYS=30).
- **Off-hours window** = America/Chicago 02:00–05:00, mirroring media-ingestion.
- **Signal hooks** enqueue into an in-process debounced queue (coalesces bursts:
  ~10s debounce, 60s max wait) rather than generating inline: new gift, new
  opportunity/pledge, new matched email (gmailSync), new matched meeting
  (calendarSync), new/linked media mention (mediaIngest). Donor-XOR signals send
  org/individual FKs; matched signals send personIds/organizationIds arrays.
- **Disable flags**: NODE_ENV=test and DISABLE_TASK_SUGGESTIONS=1 (generation);
  DISABLE_SYNC_SCHEDULER=1 also stops the monthly scheduler.
- **Manual triggers**: in-process one-time backfill via writing
  `/tmp/backfill-task-suggestions/trigger` + workflow restart (survives shell
  teardown the way standalone tsx doesn't); CLI scripts `backfill:task-
  suggestions` (--max N) and `refresh:task-suggestions` (--force) for bounded
  verification.
- **Known gap**: household donors aren't expanded to member people, so a gift to
  a household doesn't trigger a person/org suggestion (follow-up).
