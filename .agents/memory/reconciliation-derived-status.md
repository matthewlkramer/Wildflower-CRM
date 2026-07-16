---
name: Reconciliation status is derived, not stored
description: staged_payments + stripe_staged_charges lifecycle status is derived from facts at read time; vocabulary pending|match_proposed|match_confirmed|excluded; "rejected" removed from the model.
---

# Reconciliation status is derived, not stored

**The rule.** `staged_payments` and `stripe_staged_charges` carry NO stored
lifecycle status. Status is derived at read time from facts, with
`artifacts/api-server/src/lib/derivedStatus.ts` as the single source of truth
(SQL CASE fragments + WHERE predicates + TS derivations, kept mutually
consistent). Emitted vocabulary everywhere:
`pending | match_proposed | match_confirmed | excluded`.

- `excluded` ⇐ `exclusion_reason IS NOT NULL` (the sole exclusion signal)
- `match_proposed` ⇐ `auto_applied` + no `match_confirmed_at` + a gift link
- `match_confirmed` ⇐ any gift link (matched/created/group-reconciled), a
  CONFIRMED settlement link naming the row as the deposit lump (QB only), or a
  counted `payment_applications` row anchored on the row (QB only — covers splits)
- `pending` ⇐ none of the above

**"Rejected" no longer exists.** Reject endpoints and the rejected queue are
gone; human "take this out of the queue" is exclusion (with a reason). Legacy
rejected rows were backfilled to `exclusion_reason='other'` before the stored
column drop (migration 0117) so they can't re-enter the pending queue.

**Why:** stored status kept drifting from facts (approve/revert paths missed
updates), producing stale-queue bugs. Deriving from facts makes drift
impossible; rows whose stored status disagreed with facts intentionally
re-surface as pending work.

**How to apply:**
- Never add a stored lifecycle status back to these tables; add FACT columns
  and extend the derivation instead.
- Any new queue/filter/count must go through `derivedStatus.ts` helpers —
  never inline a status predicate. For `alias()`ed or raw-SQL queries use the
  alias-parameterized text builders (`qbStatusCaseText(alias)` /
  `chargeStatusCaseText(alias)` + open/claim/evidence predicate builders) —
  aliases are validated (`^[a-z_][a-z0-9_]*$`, reserved internal aliases
  rejected) and double-quoted, so never feed them user input anyway. The
  base-table drizzle fragments are themselves derived FROM the builders, so
  there is exactly one CASE definition; SQL-rendering + PostgreSQL-execution
  parity tests (derived-status-builders / derived-status-parity) fail on any
  divergence.
- Donorbox is the exception: `donorbox_donations.status` stays STORED
  (write-driven lifecycle) but is mapped to the shared vocabulary at the API
  edge via `donorboxEmittedStatus()` — wire it at EVERY emit point (list +
  single-row loader), or the old vocabulary leaks.
- The `staged_payment_status` pg enum TYPE survives only for Donorbox.
- Card queue name for confirmed work is `done` (was `reconciled`).
- Older memory notes that mention a stored `status` column or a `rejected`
  state on staged payments/charges predate this flip.
