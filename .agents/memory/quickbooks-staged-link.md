---
name: QuickBooks staged-payment "link to existing gift"
description: Why staged_payments.created_gift_id is overloaded for created-vs-linked, and the no-DB-constraint double-link guard.
---

The staged-payments review queue supports two resolutions: "Approve → create
gift" (mints a new gifts_and_payments row) and "Link to existing gift" (ties the
QB record to an already-recorded gift, no new row).

- **created_gift_id is overloaded** — both flows set `staged_payments.created_gift_id`
  to the resulting gift; "linked" reuses the same FK as "created". To tell them
  apart there is now `staged_payments.gift_was_linked` (boolean, NOT NULL DEFAULT
  false): true only for the link endpoint, explicitly false on the mint/approve
  path. **Never infer linked-vs-minted from created_gift_id** — read the flag.

- **Unlink only ever severs a LINKED approval, never a minted one.** Unlinking a
  minted approval would orphan the gift it created, so the unlink endpoint's guard
  is `WHERE status='approved' AND gift_was_linked=true` (in the UPDATE predicate,
  not just the pre-read; 409 on rowCount 0). It clears created_gift_id + approval
  stamps and returns the row to `status='pending'`, leaving donor FKs / matchStatus
  intact so it lands back in Pending·Matched. **Why the flag was needed:** without
  it the queue couldn't distinguish a linked approval (safe to undo) from a minted
  one (unsafe). **History caveat:** approvals predating the column all read false,
  so historically-linked rows are intentionally NOT unlinkable (no reliable way to
  reconstruct the resolution after the fact).

- **One gift ↔ one staged payment is enforced in app code, not the DB.** There is
  no unique index on `created_gift_id`. The link endpoint guards double-counting
  with an atomic conditional UPDATE: `WHERE id=:id AND status='pending' AND NOT
  EXISTS (other staged row with same created_gift_id)`, and 409s on rowCount 0.
  **How to apply:** any new path that links/approves a staged row to a gift must
  keep that predicate (or finally add the partial unique index) or concurrent
  requests will double-link.

- Candidate search matches **saved donor + an amount BAND** (was exact): gift.amount
  between `staged.amount - 0.01` and `staged.amount * 1.10 + 1`, ordered by amount
  closeness then date proximity. **Why:** Donorbox-style platforms keep a processing
  fee, so the CRM gross gift (e.g. $50) is slightly larger than the QB net deposit
  (e.g. $47.25); exact equality hid the real match. Donor mismatch is still rejected
  on link; amount is NOT re-enforced server-side. Pure logic in `validateGiftLink`
  (`lib/quickbooksLink.ts`); the band lives in the gift-candidates route.

- **Donor name often lives in the memo, not payer_name.** Donorbox→QuickBooks
  deposits arrive with a blank CustomerRef (payer_name null) and the donor in
  `raw_reference` (e.g. "Donation for <Project> - <Donor Name>"). `autoMatchDonor` has an
  ADDITIVE fallback (`candidateNamesFromReference`) that fires only after email +
  payerName miss and still requires a strict, unambiguous exact CRM name hit — so it
  never weakens matching. Won't catch near-misses like "Fidelity Foundation" vs CRM
  "Fidelity Foundations".

- **Auto-match runs at INSERT only; sync never re-matches existing rows.** The sync
  onConflict deliberately leaves donor match/status untouched on re-sync. To apply an
  improved matcher to already-staged rows there is a separate admin-gated backfill
  (`rematchStagedPayments` / POST /quickbooks/rematch, "Re-run matching" button).
  **Why:** agent can't write prod; the backfill runs IN the prod server when an admin
  clicks it. It's additive/idempotent — only rows still pending+unmatched+donor-less,
  guarded conditional UPDATE re-checks that predicate so a concurrent human resolve is
  never clobbered, never un-matches, shares the QB advisory lock (ran=false if a
  sync/rematch is already running).
