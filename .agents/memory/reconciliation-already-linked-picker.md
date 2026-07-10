---
name: Reconciliation "already linked to another gift" pickers
description: How the workbench gift/payment search pickers detect + gray a candidate already tied to a gift, and why the split-resolved edge case is safe.
---

Both reconciliation re-link pickers surface a candidate that is ALREADY tied to a
gift (grayed row + amber note + an "Unlink" button), so a user re-links instead of
double-booking (invariant #4):

- Forward picker — RetargetDialog "Search for a gift…" (reconciliation-workbench.tsx):
  finds a GIFT already matched to another QB record; Unlink reverts the OWNING staged
  payment (unlinkOwningStagedPayment → useRevertStagedPayment), then re-searches.
- Reverse picker — PaymentLinkDialog (reconciliation-stray-gifts.tsx): searches QB
  staged payments (GET /api/reconciliation/qb-search); a candidate is "already linked"
  when `alreadyLinkedGiftId != null`.

**The "already matched to a gift" signal is `COALESCE(matchedGiftId, createdGiftId,
groupReconciledGiftId)`** — the SAME `resolvedGift` COALESCE the reconcile/revert
service uses (quickbooks/shared.ts), and the inverse of its `hasNoGiftLink`
(all-three-NULL) predicate. Do NOT consult the payment_applications ledger for this
gray-out.

**Why not the PA ledger:** those three columns are the canonical resolution pointer
the revert path keys off; the PA ledger is the cash-application M:N, not the
"which gift owns this row" pointer.

**Known safe edge case:** a SPLIT-resolved staged payment carries none of the three
pointers, so it appears un-grayed in the reverse picker. This is cosmetic only —
POST /staged-payments/:id/reconcile 409s on `status !== "pending"`, so a second link
is impossible regardless of the gray-out.

**Unlink blast radius (button copy is just "Unlink"):** reverting a group member
reverts the WHOLE deposit group to pending; reverting a createdGiftId+autoApplied row
DELETES the auto-minted gift; a manual createdGiftId row 409s `not_revertible`
(surfaced as a toast). On success both pickers must invalidate the qb-search key AND
the gifts-missing-QB list (`/api/reconciliation/gifts-missing-qb`).
