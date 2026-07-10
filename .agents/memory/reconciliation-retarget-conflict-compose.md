---
name: Reconciliation re-target conflict composition
description: How multiple "gift already sourced/linked" re-target conflicts compose into one confirmation in the reconciliation workbench.
---

Re-targeting a QB staged payment onto a CRM gift can hit two independent
"already claimed" conflicts at once: the gift is already Stripe-sourced from a
DIFFERENT charge (switchStripeSource) AND already QB-linked to a DIFFERENT staged
payment (displaceLinkedPayment). They must resolve in ONE confirmation.

**Rule:** the consistency gate COLLECTS all issues (never early-returns), so a
single approve returns every conflict together; the frontend detects each with
its own `extract*Conflict` helper, opens ONE combined confirm dialog, and re-
POSTs with whichever confirmation flags apply. One server call clears both.

**Why:** a Stripe-backed deposit legitimately trips both at once; forcing two
sequential confirmations would be a dead-end (resolving one still 409s on the
other). Keeping the gate additive is what lets new conflict types compose for
free.

**How to apply:**
- New re-target conflict type = add a gate issue code + a body confirmation flag
  (contract-first: edit `lib/api-spec/openapi.yaml`, regenerate). Never early-
  return from the gate; push the issue and continue.
- Incumbent lookup in the route must use the SAME predicate the commit's link
  UPDATE guard uses (`qbLedgerPaymentIdForGiftExcludingPayment`, both args bound
  params) so detection and commit can never disagree.
- Displacement only safe for a DIRECT-match incumbent (`matchedGiftId===gift`
  AND `groupReconciledGiftId==null`); group/split incumbents throw
  `incumbent_not_displaceable` — half-releasing them corrupts the group/split
  invariant. Release mirrors the QB single-payment revert path.
- Locking a 2nd staged row after the anchor carries a rare cross-displacement
  deadlock risk (Postgres aborts one txn, retryable) — accepted for this manual
  admin action.
