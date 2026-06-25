---
name: Cleanup queue flag-for-research
description: How records get added to the Cleanup Queue (needs_research) from the app, and its idempotency/id contract.
---

# Cleanup queue "Flag for research"

`POST /cleanup-queue` (operationId `flagForResearch`) lets fundraisers add any
record (opportunity/pledge/organization/person/gift) to the Cleanup Queue with
`reason_code = 'needs_research'` from the detail page (shared
`FlagForResearchDialog` component, placed next to the Archive action).

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
