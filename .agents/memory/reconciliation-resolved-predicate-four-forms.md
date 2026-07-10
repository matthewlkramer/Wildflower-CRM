---
name: Reconciliation "resolved to a gift" has FOUR forms
description: Any staged-payment predicate deciding "is this money booked/resolved" must enumerate matched + created + group-reconciled + split, not just the id columns.
---

A QuickBooks/Stripe staged payment can be resolved to a CRM gift in four
distinct ways, and only three of them live in columns on `staged_payments`:

1. `matchedGiftId` — 1:1 match to an existing gift.
2. `createdGiftId` — minted a new gift.
3. `groupReconciledGiftId` — grouped into another row's gift (member rows).
4. **split** — one payment across several existing gifts. A split deliberately
   carries **NONE** of the three id columns; its resolution lives entirely in
   `staged_payment_splits` (+ dual-written `payment_applications` rows).

**Why:** the reconciliation cards live-queue predicate
(`reconciliationQueueWhere('all')` in `routes/reconciliation/cards.ts`) only
checked matched/created, so a fully-split (and a group-reconciled) approved row
failed the "has a gift" test and was wrongly re-admitted to the "unlinked money"
queue — the payment kept showing as unresolved after a correct split.

**How to apply:** whenever you write or edit a predicate that decides whether a
staged payment is resolved/booked, enumerate all four forms. For the split form,
key off `EXISTS (staged_payment_splits WHERE staged_payment_id = <outer>.id)` —
NOT off `payment_applications` (that ledger was a phased additive backfill, so
legacy resolved rows may lack PA rows). The schema doc on `stagedPaymentSplits`
is the authority: "when a staged row is split it carries NONE of matchedGiftId /
createdGiftId / groupReconciledGiftId." (See also
`reconciler-approvable-statuses.md`, which makes the same point for the mint
double-count guard but predates the split form.)
