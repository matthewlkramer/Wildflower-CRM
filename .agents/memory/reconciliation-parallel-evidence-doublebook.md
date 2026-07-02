---
name: Reconciliation double-book guard is anchor-kind-aware
description: A gift's "already linked elsewhere" guard must count only SAME-kind evidence; QB+Stripe are parallel evidence for one gift.
---

# Reconciliation double-book guard must be anchor-kind-aware

When reconciling settlement money to an existing CRM gift, the "this gift is
already linked to other money" guard must count ONLY evidence of the SAME kind as
the anchor row:

- A **Stripe charge** anchor double-books only against ANOTHER Stripe charge
  (`stripe_staged_charges.matched_gift_id` OR `created_gift_id`).
- A **QB staged payment** anchor double-books only against ANOTHER QB link
  (staged direct FK `created/matched/groupReconciled_gift_id`, or the
  `payment_applications` QB ledger).
- A **cross-kind** link (a charge landing on a QB-reconciled gift, or vice versa)
  is EXPECTED parallel evidence — it must NOT disable the picker or block confirm.

**Why:** QuickBooks and Stripe are parallel evidence for ONE gift (see
reconciliation-single-source-of-truth). A blended guard that counted both kinds
produced a false positive: the correct gift showed DISABLED "Already linked to
another payment" when matching a Stripe charge to a gift that had a normal QB
cash-application row. Fixing only the picker's disable flag left the identical
false positive one gate later (derive/confirm), so the fix must be applied at
every layer.

**How to apply:** this guard lives at FOUR layers that must stay in lockstep — a
fix to one without the others just moves the false positive downstream:
1. **Search endpoint disable flag** (`reconciliationGraph.ts`,
   `alreadyLinkedStagedPaymentId`) — charge anchor overrides the QB-ledger flag
   with a charge-only helper.
2. **Derive/confirm gate** (`reconciliationBundleProposal.ts`) —
   `GiftFact` carries `linkedByStagedPaymentId` + `linkedByChargeId` separately;
   `linkedElsewhereFor(base, fact)` picks by `base.stripeChargeId` (charge) vs
   staged. Confirm re-derives via the same `rowWarnings`, so its 409 inherits it.
3. **Tx-time write guard** (`reconciliationBundleCommit.ts`) —
   `linkChargeToGiftInTx` checks only other charges (matched OR created, closing
   the created_gift_id gap the partial-unique index doesn't cover);
   `linkGiftInTx` checks only the QB ledger.
4. **Discriminator:** a bundle row sets exactly one of
   `{stripeChargeId, stagedPaymentId}`; use `stripeChargeId ? charge : staged`.
