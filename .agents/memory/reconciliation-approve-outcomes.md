---
name: Unified reconciler approve — gift ownership & revert coherence
description: How the complete-match reconciler approve route ties evidence rows to a gift across outcomes, and why the QB-vs-Stripe linkage is asymmetric.
---

# Unified reconciler approve — gift ownership & revert coherence

The QB-anchored complete-match reconciler approve route
(`POST /reconciliation/cards/:stagedPaymentId/approve`) ties evidence rows to a
single CRM gift. Across ALL outcomes the linkage follows one rule:

- **The QB staged_payments row is the gift's OWNER/anchor.**
  - `link_existing_gift` → `matchedGiftId = giftId` (gift pre-existed).
  - `create_gift` → `createdGiftId = newGiftId`, `matchedGiftId = null`,
    `autoApplied = false` (the QB anchor minted it).
- **A selected Stripe charge is ALWAYS `matchedGiftId` evidence — never
  `createdGiftId`** — identical in both outcomes. It is the precise GROSS amount
  source, not the owner.

**Why this asymmetry (do not "simplify" it):**
1. `autoApplied = false` + `createdGiftId` is the signal the QuickBooks revert
   path treats as a PROTECTED manual mint (NOT auto-revertible) — same as the
   manual `/staged-payments/:id/create-gift` route. A human mint must not be
   silently deleted by a casual QB revert.
2. The Stripe revert path deletes the gift for ANY `createdGiftId` on a charge
   but only UN-SOURCES (unstamp, gift survives) for `matchedGiftId`. Keeping the
   charge on `matchedGiftId` means reverting Stripe just removes Stripe as the
   amount source; the gift the QB anchor owns survives.
3. If the charge held `createdGiftId`, a Stripe charge-revert gift-DELETE would
   be blocked by the `staged_payments.created_gift_id` FK (the QB row still
   points at the gift) — an FK landmine. `matchedGiftId` avoids it.

**Other create_gift invariants:**
- Mint is HUMAN-ONLY and HEADER-ONLY (no allocations; a fundraiser apportions
  after) — mirrors the manual create-gift route.
- FINAL amount stamped AT INSERT: Stripe GROSS (+ `processorFee` = charge fee,
  `finalAmountSource='stripe'`, pointer = charge) when a charge is selected, else
  the QB staged amount (`finalAmountSource='quickbooks'`, pointer = staged).
  `originalHumanCrmAmount` stays null (no prior human figure).
- create_gift is intentionally **NOT idempotent** — re-approving an
  already-reconciled staged row is `409 not_approvable` (a second approve would
  mint a duplicate). Contrast: `link_existing_gift` IS idempotent (re-approve to
  the same gift returns current state).
- The consistency gate runs over a SYNTHETIC new gift whose `amount = evidence`,
  so the amount-band check is tautological by design; the gate still enforces QB
  anchor presence, Donor XOR, Stripe payout membership, and Stripe-required
  precedence.

**Known non-blocking race (matches E3):** `stagedPayoutIds` is read before the tx
and not re-derived after the payout `FOR UPDATE` lock, so a concurrent payout
reproposal could let the gate see stale payout membership. Left consistent with
E3; revisit for both paths together if tightened.
