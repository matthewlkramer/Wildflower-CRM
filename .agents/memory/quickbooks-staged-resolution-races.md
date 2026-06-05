---
name: QuickBooks staged-payment resolution race-safety
description: Why every staged-payment state-transition endpoint must guard status='pending' in the UPDATE itself, not just a pre-read.
---

# Staged-payment resolution endpoints must be TOCTOU-safe

All staged-payment write endpoints (resolve, approve, reject, confirm-match,
unmatch) do a friendly pre-read for 404 / clear error messages, but the **real
guard must live in the `UPDATE ... WHERE` clause**, and zero affected rows must
return 409.

**Rule:**
- Status transitions: `WHERE id = ? AND status = 'pending'`; `if (!row) → 409`.
- confirm-match additionally needs the donor-present predicate *in the UPDATE*:
  `num_nonnulls(organization_id, individual_giver_person_id, household_id) >= 1`,
  so a concurrent unmatch can't leave a matched/human-approved row donor-less.
- approve mints a gift + flips status in one tx: `SELECT ... FOR UPDATE` the
  staged row first, re-read + re-validate the donor under the lock, then mint
  the gift from the *locked* snapshot. A status-only guard is not enough here —
  a concurrent unmatch/resolve can change/clear the donor while status stays
  'pending', so a stale pre-read donor would otherwise mint a wrong-donor gift.
  The lock serializes those and re-validation throws a sentinel → 409/400.
- link points `created_gift_id` at an existing gift (independently correct
  donor/amount), so its staged-donor check is a UX guard only — a stale-donor
  race there cannot mint incorrect ledger data and is not severe.

**Why:** a pre-read + unconditional `WHERE id=?` is a classic TOCTOU window — a
concurrent approve/reject/unmatch between read and write silently clobbers state
(e.g. minting a gift on an already-rejected row, or confirming a donor that was
just cleared). The pre-read alone does not prevent it.

**How to apply:** any new staged-payment (or similar status-machine) mutation
follows the same conditional-UPDATE + 409-on-zero-rows pattern. The three match
states are derived, never written as a column: unmatched = matchStatus
'unmatched'; system matched = 'matched' AND matchConfirmedAt NULL; human
approved = matchConfirmedAt NOT NULL — independent of review `status`.
