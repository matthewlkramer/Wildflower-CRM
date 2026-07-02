---
name: Gift QuickBooks tie status
description: The derived-but-persisted quickbooks_tie_status invariant on gifts — when to recompute, what exempts, how amounts compare.
---

# Gift ↔ QuickBooks tie status

`gifts_and_payments.quickbooks_tie_status` (`exempt|tied|amount_mismatch|missing`)
is **derived but persisted** — same shape as opportunity status: a pure deriver
plus a DB-touching applier (`applyGiftQbTieMany`) that reads via the global `db`
and so must run AFTER the mutating tx commits. Never hand-write the column.

**The invariant:** any path that links/unlinks a gift to QB/Stripe evidence, or
changes the compared amount, MUST recompute the affected gift id(s). On revert
paths, recompute only the SURVIVING gifts — branches that DELETE the gift (auto-mint
revert) must be skipped, not recomputed.

**Why:** the persisted flag is what powers the gifts-list `untied` filter and the
audit view. A path that mutates linkage but skips the recompute leaves the flag
stale, silently hiding an untied gift from the reconciliation surface. Grep for
`applyGiftQbTieMany` to find/maintain the call sites; treat each gift-mutation
route as needing one.

**Derivation rules (the durable decisions):**
- Exempt = `off_books_fiscal_sponsor OR designated_to_school` — exempt wins over
  everything.
- Amount compared with the reconciler's `amountWithinFeeBand` so the flag agrees
  with the reconcile gate. Can't prove a mismatch without both amounts ⇒ `tied`.
- QB amount precedence when several mechanisms resolve: split.sub_amount >
  SUM(group staged.amount) > direct matched/created staged.amount.
- Stripe-sourced (`final_amount_source='stripe'`) with no direct QB link ⇒ `tied`
  (money lands in QB at the payout level, not per-charge).
- On-books with no QB evidence ⇒ `missing`.

**Source-agnostic ledger cutover (reconciliation redesign Phase 2/3 reads):**
The deriver (`giftQbTie.ts`) no longer reads legacy pointer columns; it reads
`payment_applications` `link_role='counted'` rows. `applyGiftQbTieMany` combines
sources by **PER-SOURCE PRECEDENCE (qb > stripe > donorbox), NOT an all-source
SUM.**
**Why:** a gift settled by BOTH a coarse QB deposit line AND its per-charge Stripe
rows carries a counted row of EACH source (migration 0086 does not, and must not,
dedupe across sources). Summing them ~2×'s the linked amount → false
`amount_mismatch`. A read-only prod parity confirmed this: 0 tie changes but 15
cross-source pairs that a naive SUM would have broken.
**When the all-source SUM becomes correct:** Phase 4, once `settlement_links`
reclassifies the coarse QB row to `link_role='corroborating'` so only one counted
row per unit of money remains.
**How to apply:** use the per-source counted helpers in `paymentApplications.ts`
(`{qb,stripe,donorbox}LedgerExistsForGift` / `…SumForGift`); each takes a
pre-qualified gift-id SQL expression (bare-column footgun — see
`drizzle-sql-template-bare-column.md`). The `gifts-missing-qb.ts` "processor
settled" predicate is `stripeLedgerExistsForGift() OR donorboxLedgerExistsForGift()`
(was legacy `isStripeTiedSql` over `final_amount_source`/`stripe_staged_charges`).
`coding-form-import.tsx`'s `matchedGiftId` is a coding-import STAGING pointer
(`coding_form_rows.matched_gift_id`), NOT a cash-application link — leave it.

**Audit view:** off-books (exempt) gifts are EXCLUDED from the
`/audit-reconciliation` read view — return early with `auditExcluded:true` and no
trail, do not compute donor/QB-records/restrictions for them.

**Schema delivery:** the enum + 2 columns + index ship as an idempotent SQL file
(not the Publish diff alone) because drizzle push aborts on unrelated pre-existing
`conditions_met` drift, which would skip all additive changes.
