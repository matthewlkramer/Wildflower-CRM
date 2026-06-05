---
name: QuickBooks staged-payment "link to existing gift"
description: Why staged_payments.created_gift_id is overloaded for created-vs-linked, and the no-DB-constraint double-link guard.
---

The staged-payments review queue supports two resolutions: "Approve → create
gift" (mints a new gifts_and_payments row) and "Link to existing gift" (ties the
QB record to an already-recorded gift, no new row).

- **created_gift_id is overloaded** — both flows set `staged_payments.created_gift_id`
  to the resulting gift; "linked" reuses the same FK as "created".
  **Why:** chosen to avoid a prod schema migration (user prefers non-destructive
  changes; agent can't write prod). There is no DB-level flag distinguishing
  created vs linked. If you ever need to tell them apart, add a column via the
  staged SQL-file flow, don't infer.

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
