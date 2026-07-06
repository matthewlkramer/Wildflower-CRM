---
name: Multi-charge payout per-charge link-gift path
description: Why a per-charge reconciler card in a multi-charge Stripe payout can't approve via the deposit path, and the dedicated link-gift endpoint that fixes it.
---

# Multi-charge payout → per-charge link-gift

A Stripe payout that fans out to MORE THAN ONE charge settles into a single
QuickBooks deposit "lump". On the reconciliation workbench, a per-charge card in
that situation cannot route its Approve through the DEPOSIT-level approve: the
deposit's reconciliation graph carries `evidence.stripe.chargeId === null` when
charges > 1, so the deposit-approve gate 409s (`stripe_charge_required`). This was
the reported "Ayeisha" bug — "tried to approve, wouldn't work because it has stripe
detail."

**Rule:** for a per-charge card of a multi-charge payout, LINK the individual
charge to its existing gift as evidence via the dedicated per-charge money path
(`POST /stripe-staged-charges/{id}/link-gift`), never through the deposit approve.
The charge adopts the gift's donor, the gift's final-amount provenance is stamped
to the charge GROSS (no fee-band gate; the settled amount is derived at read time,
`amount` is NOT rewritten), and no new gift is minted.

**Why:** the deposit-level graph is intentionally charge-agnostic when a payout has
multiple charges (there is no single chargeId to attribute), so the per-charge
approve has no path through it. A separate single-charge link path is the clean fix
(architect-approved "Approach B"); it reuses the settlement-bundle
`linkChargeToGiftInTx` helper so the guards (still-pending, partial-unique on
`matched_gift_id`, created-gift ownership pre-check → 409 `link_conflict`) match the
bundle path.

**How to apply:**
- Client detects the case as `card.stripeChargeId != null` AND
  `graph.evidence.stripe != null && graph.evidence.stripe.chargeId == null`, and
  calls link-gift FIRST inside the approve/retarget flow. Single-charge deposits
  (chargeId present) return false and fall through to the unchanged deposit approve.
- Bulk approve is NOT exempt: the workbench's multi-select Approve splits the
  selection — a genuine multi-charge card (`stripeChargeCount > 1`) links via
  link-gift immediately (skips no-gift charges), while single-charge and deposit
  cards go through the deposit staging tray. Keep this split (`stripeChargeCount`
  is the client-side proxy for the graph's `evidence.stripe.chargeId == null`) or
  single-charge cards reach a different terminal state than a single-card approve.
- Lock order is gift FOR UPDATE then charge FOR UPDATE (matches the bundle
  convention — don't invert it or you can deadlock against bundle confirm).
