---
name: needs_research flag is human-only and non-durable
description: Why the reconciliation "Research" queue can go empty; needs_research is unaudited and lost on staged_payments wipe/re-pull.
---

`staged_payments.needs_research` is a pure human annotation set ONLY by
`POST /staged-payments/:id/set-needs-research`. Nothing derives or auto-clears it.

- The endpoint writes NO `audit_log` row, so there is no trail of which rows were
  ever flagged.
- A `staged_payments` wipe + re-pull (clean re-ingest) inserts fresh rows, so every
  human-set `needs_research` flag is lost and unrecoverable (no audit to replay).

**Why:** an empty Research queue after a re-ingest looks like a bug but is expected
data loss. Both prod and dev were observed at 0 flagged rows.

**How to apply:** if the Research queue is unexpectedly empty, check the flag count
directly (`SELECT count(*) ... WHERE needs_research`) before assuming a UI bug. If
flag durability ever matters, add an `audit_log` write to set-needs-research (so
flags can be replayed) and/or show flagged rows regardless of status — the research
view currently filters `status='pending'`, so a flagged row silently drops once it
is resolved.
