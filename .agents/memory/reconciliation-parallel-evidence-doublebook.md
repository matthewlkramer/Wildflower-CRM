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

## The candidate-DISCOVERY window is a fifth layer (not just the guard)

The same parallel-evidence blindness also hid the gift from the MATCHER, one step
earlier than the "already linked" guard. `giftsInWindow` (quickbooksMatch.ts)
excluded any gift claimed by EITHER a staged_payment OR a stripe_staged_charge,
regardless of which channel was scoring. So a Stripe charge whose exact same-amount
gift was already booked from QuickBooks found ZERO candidates → the settlement
bundle auto-MINTED a duplicate. Symptom: "every bundle proposes to mint a new gift
even though the existing gift is obviously in the system waiting to be matched."

- `giftsInWindow` now takes an `EvidenceKind` (`"staged"` default | `"charge"`).
  `"staged"` excludes BOTH channels (QB sync-worker safety — never re-link a gift
  its own channel owns). `"charge"` drops ONLY the staged-payment exclusion, so a
  QB-booked gift stays a valid Stripe reconcile target. Threaded via
  `ScoreInput.evidenceKind`; `stripeMatch.ts` passes `"charge"`.
- The bundle-proposal auto outcome (`baseRowFrom`) must gate mint on
  `giftCandidateCount === 0`; any candidates ⇒ `"research"` (never mint over
  possibly-already-recorded money), for BOTH existing and newly-proposed donors.
- `reconcileTarget` takes `GiftWindowCandidate[]` + an `anchorDate`: with ≥2
  same-amount gifts it picks the one whose `dateReceived` matches the payment day,
  else null (ambiguous). Recurring donors otherwise looked permanently ambiguous.

**Deliberately NOT loosened:** `stripeAutoApply`'s cross-kind write guard stays
strict — a high-tier charge match onto a QB-owned gift no-ops and surfaces for
human review rather than auto-linking. Cross-processor ties are a book-once
decision confirmed in the Workbench; only loosen it once book-once dedupe lives on
the ledger.
