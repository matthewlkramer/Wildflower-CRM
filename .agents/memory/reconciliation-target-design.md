---
name: Reconciliation target-state design
description: Where the ratified reconciliation simplification lives and the decisions it locked, so future phases don't relitigate them.
---

The committed target-state design for simplifying reconciliation is
`docs/reconciliation-design.md`. It is design-only (no code behavior change); it
ratifies the model and defines the prod-safe phased path (phases 2–7 are each a
future human-gated task).

**The model:** two planes (Plane 1 settlement = Stripe payout ↔ QB deposit;
Plane 2 donor-credit = unit ↔ gift, where a unit is a Stripe charge, a non-Stripe
QB payment, or a non-Stripe Donorbox donation), one unit↔gift link ledger, one
small settlement-link table, all statuses derived (no new stored status columns),
and two three-column reports (Settlement; Gift with a funding-source filter).

**Resolved open decisions (don't relitigate):**
1. Two link tables, not one — extend `payment_applications` to the unit↔gift
   ledger (polymorphic `source_id` + `link_role` + `lifecycle` + `provenance`);
   a separate `settlement_links` for batch↔batch (its source is `stripe_payouts`,
   which doesn't fit `payment_applications.payment_id → staged_payments`).
2. Fold `gift_evidence_links` into the ledger as `link_role='corroborating'`
   (excluded from the book-once SUM); counted rows = money trail (RESTRICT),
   corroborating = re-derivable (droppable on gift delete).
3. Keep the two-lane funding/crmRecord view but derive both lanes purely from the
   ledger (retire the mixed ledger+legacy reads).
4. UI = incremental collapse to a locked 2-report IA, not a from-scratch rewrite
   of the 3,651-line workbench; "needs review"/"excluded" become filters.
5. Ratify extending the ledger to Stripe/Donorbox unit links (reverses the prior
   "QB-only ledger" decision; `evidence_source` already carries stripe/donorbox).

**Why:** finish the half-done ledger cutover and delete superseded layers rather
than invent a new paradigm. Book-once stays service-layer (INV-B), CRM gift stays
single source of truth (INV-A), match state stays orthogonal to classification
(INV-E). Any read cutover is prod-parity-gated (dev parity ≠ prod).
