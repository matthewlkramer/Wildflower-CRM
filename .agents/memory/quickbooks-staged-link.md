---
name: QuickBooks staged-payment ↔ gift linkage invariants
description: How a staged QB payment resolves to a gift — distinct matched/created columns, DB-level one-to-one uniqueness, and mint-gate vs reconcile-target semantics.
---

The staged-payments review queue resolves each QB incoming-money unit to a gift in
exactly one of two mutually-exclusive ways:

- **`matched_gift_id`** — RECONCILE: linked to a PRE-EXISTING gifts_and_payments
  row (no new ledger row).
- **`created_gift_id`** — MINT: a NEW gift was created from the staged row.

**These are separate columns** (an earlier design overloaded one `created_gift_id`
with a `gift_was_linked` flag — that is gone). Unlinking is only valid for
`matched_gift_id` (unlinking a minted gift would orphan it).

- **One staged row ↔ one gift is enforced at the DB level.** Partial-unique indexes
  on `matched_gift_id` and `created_gift_id` (each `WHERE ... IS NOT NULL`, so the
  many NULL/unresolved rows don't collide) guarantee at most one staged row links to
  or mints any given gift. **Why:** under READ COMMITTED, two concurrent reconciles
  each pass a `NOT EXISTS` pre-check and both commit (write-skew) — the index is the
  only hard backstop. **How to apply:** every link/reconcile/mint path keeps BOTH a
  `NOT EXISTS (other staged row with same matched/created gift)` predicate in its
  conditional UPDATE (fast common-case 409 / leave-pending) AND catches Postgres
  `23505` — manual reconcile route → 409, auto-apply worker → return false (row
  stays pending). Don't rely on the predicate alone, and don't drop the index.

- **Mint-gate and reconcile-target are DIFFERENT predicates** (do not conflate):
  - *Reconcile target* (`matchedGiftId`): set only when there is EXACTLY ONE
    exact-amount gift (within $0.01).
  - *Mint gate* (`giftCandidateCount === 0`): auto-mint only when NO *plausible*
    gift exists, where plausible = the fee BAND (`amount >= staged-0.01 AND <=
    staged*1.10+1`). **Why:** Donorbox-style platforms keep a processing fee, so the
    CRM gross gift is slightly larger than the QB net deposit; an exact-only mint
    gate would mint a duplicate next to the real fee-different gift. So `giftsInWindow`
    returns `{ exact[], plausibleCount }` and excludes already-linked gifts (NOT
    EXISTS) so a claimed gift never counts as a reconcile target nor blocks a mint.

- **`matchConfirmedAt` is the SOLE "confirmed" signal in the UI.** `matchStatus`
  can be `'matched'` while still only a system guess (the high-tier rematch path
  sets `matched` on pending rows without confirming). The reconciler's `matchStateOf`
  must treat unconfirmed `matched` as `suggested` (offer Confirm), never as confirmed.

- **Donor name often lives in the memo, not payer_name.** Donorbox→QB deposits
  arrive with a blank CustomerRef (payer_name null) and the donor in `raw_reference`
  / line description. The matcher has an additive `candidateNamesFromReference`
  fallback that fires only after email + payerName miss and requires a strict exact
  CRM name hit, so it never weakens matching.

- **Deposit ingestion is per-line; skip ONLY lines linked to a Payment/SalesReceipt.**
  A deposit bundles many donors (one per line). A line's LinkedTxn is a duplicate of
  an already-ingested unit only when its `TxnType` is `"Payment"` or `"SalesReceipt"`
  — skipping ANY linked line (older bug) drops legitimate direct deposit lines.

- **Auto-match runs at INSERT + an explicit admin rematch; sync never re-matches on
  re-sync.** The sync onConflict leaves donor match/status untouched. Improved
  matchers reach already-staged rows via the admin-gated backfill (POST
  /quickbooks/rematch), which is additive/idempotent, only touches still
  pending+unmatched+donor-less rows, and is DONOR-ONLY (never mints/reconciles a gift).
