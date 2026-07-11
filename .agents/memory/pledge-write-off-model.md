---
name: Pledge write-off model (multiple, one editable)
description: Audit-close pledge write-offs — many over time, one editable at once; app-level lock replaced the unique index; capacity math must stay lockstep in 3 places.
---

# Pledge write-off model

The rule: a frozen (audit-closed FY), under-paid written pledge may accumulate
MULTIPLE write-off children over time, but only ONE *editable* write-off (its own
governing FY still open, non-archived) may exist at a time. A new attempt while an
editable child exists returns 409 `editable_write_off_exists` with
`details.writeOffPledgeId`/`writeOffPledgeName`. The write-off amount is
user-chosen, capped at the remainder NET of prior active write-offs; over-cap is
409 `amount_exceeds_remainder` with `details.maxAmount`.

**Why:** finance re-closes years — a partial write-off must leave the pledge
flaggable for the residual, and a frozen write-off can never be edited, so a new
one must be mintable. But two simultaneously-editable write-offs would double-count
resolution.

**How to apply:**
- The old partial-unique "one active write-off per original" DB index was DROPPED
  by design (migration ships with the feature). Concurrency safety is now ONLY the
  app-level `FOR UPDATE` lock on the original pledge row inside the write-off
  transaction — never remove that lock, and publish code BEFORE applying the
  index-drop migration.
- Capacity = committed(sum pledge allocations) + writtenOff(negative child
  allocation totals, non-archived) − paid. This math lives in THREE places that
  must stay lockstep: the route's tx-aware helper (under the lock), the pre-close
  checklist lookup's HAVING/remainder (raw SQL), and the detail endpoint's
  `auditClose.uncollectedRemainder` (the dialog prefill AND server cap source).
- "Editable" = the child's freeze check on its own completion date says not
  frozen — same predicate as the PATCH edit guard, so "blocks a new write-off"
  always matches "can still be edited in place".
- An open-FY (not frozen) original pledge is never written off — it is edited in
  place (server 409 `fiscal_year_not_closed`; UI shows a friendly redirect link).
- Write-off child rows themselves (`is_write_off = true`) are excluded from the
  underpaid-pledge checklist — they are the resolution, not a new problem.
