---
name: Charge-grain Stripe↔QB ties
description: Per-charge QB tie model for Missing-deposit payouts (individually-booked donations) — proposal vs confirm semantics and settled derivation.
---

# Charge-grain Stripe↔QB ties (Missing-deposit payouts)

Some payouts were never booked as one QB deposit lump — the bookkeeper booked
each donation as its own QB row. For those, reconciliation happens at CHARGE
grain, parallel to the settlement-link (lump) path.

**Rules:**
- Two columns on `stripe_staged_charges`: `proposed_qb_staged_payment_id`
  (machine proposal, freely recomputed/cleared) and
  `linked_qb_staged_payment_id` (human-confirmed, never touched by the
  proposer). Every proposer write is guarded on the confirmed tie still NULL.
- A payout WITH a settlement link is out of charge-tie scope — the lump path
  owns it; the pass clears stale charge proposals on such payouts.
- Proposal matching: exact amount to the cent, ±20d; when several same-amount
  pairs compete, name similarity ≥ threshold is REQUIRED (never amount alone).
  Manual "Tie selected" only requires exact amount (human asserted the tie);
  all-or-nothing on issues.
- A payout is "settled" (Matched bucket) when every non-terminal
  (not excluded/rejected) charge has a confirmed tie — derived in
  bundleAnchors, no status column.
- Candidate QB rows must not be settlement-link deposits, already
  confirmed-tied, or proposed to another payout's charge.

**Why:** keeps the lump and charge-grain planes from double-booking the same
money and lets re-runs stay idempotent while a human approve always wins races.

**How to apply:** any new "is this QB row spoken for?" predicate must consider
BOTH settlement-link deposits and charge-grain ties; any new confirm path must
guard on the confirmed column, not the proposal.
