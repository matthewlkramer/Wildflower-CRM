---
name: Cleanup queue flag-for-research
description: How records get added to the Cleanup Queue (needs_research) from the app, and its idempotency/id contract.
---

# Cleanup queue "Flag for research"

`POST /cleanup-queue` (operationId `flagForResearch`) lets fundraisers add any
record to the Cleanup Queue with `reason_code = 'needs_research'` via the shared
`FlagForResearchDialog` component. `targetType` is polymorphic:
`opportunity`/`pledge`/`organization`/`person`/`gift` (from a detail page, next to
Archive) **and `staged_payment`** (from the Reconciliation Workbench's per-card
"Flag for research" menu item). For `staged_payment`, `targetName` resolves to the
QB `payerName` in both the list SQL and `enrich()`; the cleanup-queue detail link
sends the reviewer to `/reconciliation-workbench`.

**This is the SOLE research-flagging mechanism.** The old Reconciliation Workbench
"Research" view and the `staged_payments.needsResearch` boolean it wrote were
removed — that column is now `@deprecated` (kept, not dropped, to avoid a
destructive prod migration) and excluded from every API response. Do NOT
reintroduce a per-row research flag; route research flags here.

**Idempotency / id contract:**
- Deterministic PK `cleanup_nr_<targetId>` is shared between the hand-applied
  seed (migration `0077`) and the in-app endpoint, so app-created and
  seeded rows never collide on the PK.
- True idempotency is enforced by the `(target_type, target_id, reason_code)`
  unique index via `onConflictDoNothing`: re-flagging an already-flagged record
  (regardless of its open/resolved/dismissed status) returns the EXISTING row
  (HTTP 200) and never mints a duplicate or overwrites the note. A fresh flag
  returns 201.

**Why:** the queue must be grown by the team without an engineer, but must not
resurrect items a human already resolved/dismissed nor duplicate rows.

**How to apply:** if you ever want re-flagging to reopen a terminal item, you'd
have to change `onConflictDoNothing` to a guarded upsert — by design it does NOT
today. The reason_code is always `needs_research` for this endpoint; other
reason codes are seed-only.
