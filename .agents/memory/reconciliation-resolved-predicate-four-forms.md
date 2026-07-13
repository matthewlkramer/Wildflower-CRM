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
   counted `payment_applications` rows (`evidence_source='quickbooks'`,
   `link_role='counted'`). The old `staged_payment_splits` table was retired
   and dropped (migration 0115).

**Why:** the reconciliation cards live-queue predicate
(`reconciliationQueueWhere('all')` in `routes/reconciliation/cards.ts`) only
checked matched/created, so a fully-split (and a group-reconciled) approved row
failed the "has a gift" test and was wrongly re-admitted to the "unlinked money"
queue — the payment kept showing as unresolved after a correct split.

**How to apply:** whenever you write or edit a predicate that decides whether a
staged payment is resolved/booked, enumerate all four forms. For the split form,
key off `EXISTS (payment_applications WHERE payment_id = <outer>.id AND
evidence_source = 'quickbooks' AND link_role = 'counted')` — the PA ledger is
now the sole authority (splits table dropped; the backfill that once made PA
incomplete finished before the drop). Note this predicate also matches rows
resolved via the id columns (those dual-write counted PA rows too), which is
fine for "is it booked" checks. "When a staged row is split it carries NONE of
matchedGiftId / createdGiftId / groupReconciledGiftId" still holds. (See also
`reconciler-approvable-statuses.md`, which makes the same point for the mint
double-count guard but predates the split form.)
