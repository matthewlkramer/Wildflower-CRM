---
name: Reimbursable grant = pledge, checks are 1:1 payments
description: Money model for reimbursable grants in the reconciliation workbench — award is a pledge, each reimbursement check is a real gift payment.
---

# Reimbursable grant money model

A reimbursable grant (`pledge_allocations.conditional='reimbursable'` +
`loan_or_grant='grant'`) is modeled as a **pledge**, not as one lump gift.

**The rule:** the grant *award* is the pledge; each real QB/Stripe reimbursement
check must be booked as a **1:1 gift PAYMENT on that pledge at the exact
processor amount** (`create_gift_from_opportunity` with the card's own
`stripeChargeId` when present). Do NOT create placeholder award-amount "gifts" —
those are stray/incorrect and should be archivable.

**Why:** reimbursable grantors (PELSB / DEED / Early Milestones style) pay in
arrears against submitted expenses, so real money arrives as many partial checks.
Booking one award-amount gift double-counts against the actual reimbursements and
breaks pledge paid-amount derivation + QB tie. The pledge derives to `cash_in`
once fully paid via the normal payment-driven derivation (invariant #3).

**How to apply:**
- Unmatched QB/Stripe cards in the reconciliation workbench have a "Record as a
  payment on a pledge…" action → searchable pledge picker (shared `OppCombobox`)
  → approves `create_gift_from_opportunity`. Grouped/source-group cards can't use
  it (per-row approve 409s on group members) — ungroup first.
- The stray-gifts worklist ("CRM gifts unlinked to money") flags gifts on a
  reimbursable pledge (`GiftMissingQb.reimbursablePledge`, derived via EXISTS on
  `pledge_allocations` where `pledge_or_opportunity_id = gifts.opportunity_id AND
  conditional='reimbursable'`) with an amber badge + an "Archive gift" action so
  placeholder award gifts can be cleaned up.
