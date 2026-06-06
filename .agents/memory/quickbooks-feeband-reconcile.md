---
name: QuickBooks fee-band auto-reconcile
description: When a staged QB payment has one near-amount gift and no exact match, treat it as the gift net of a processor fee and reconcile (don't mint).
---

# QuickBooks fee-band auto-reconcile

A QB deposit is the **net** amount after a processor fee; the matching CRM gift
records the **gross**. So a single in-window gift whose amount sits just above the
staged amount (the "fee band") is the same money, not a separate gift.

Rule (matcher): the unambiguous reconcile target is a single exact-amount gift,
or — when there is **no** exact match — a single fee-band gift. Anything else
(2+ exact, 2+ fee-band, or none) stays ambiguous → human picks, or a gift is
minted when there are none.

**Why:** before this, only a single *exact*-amount gift auto-reconciled, so every
fee-bearing donation (card/DAF) piled up in Needs Review even though the donor and
the gift were obvious. Reconciling (not minting) avoids double-counting — the gift
already holds the gross; we never alter its amount.

**How to apply:**
- Fee band = gift.amount in `[net - 0.01, net*1.10 + 1]`, within ±60 days, same
  donor (XOR), excluding gifts already linked to another staged payment.
- The decision is the pure `reconcileTarget(exact, plausible)` helper; `plausible`
  includes the exact ids. Reconcile only fires at the high auto-apply tier.
- A one-time prod data catch-up must ship as a reviewed idempotent SQL file
  (agent can't write prod). It MUST mirror runtime exactly or existing rows
  diverge from future ingests:
  - donor match uses **donorWhere precedence** (org > person > household), not a
    flat OR across all FKs;
  - a **null staged date applies NO date filter** (not "gift date must be null");
  - dedupe so one gift is claimed by at most one staged row (the partial-unique
    index on `matched_gift_id` otherwise aborts the batch).
- Reconciled rows land in Auto-matched (`status='approved'`, `auto_applied=true`,
  `match_confirmed_at` NULL) for optional review.
