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

**Audit view:** off-books (exempt) gifts are EXCLUDED from the
`/audit-reconciliation` read view — return early with `auditExcluded:true` and no
trail, do not compute donor/QB-records/restrictions for them.

**Schema delivery:** the enum + 2 columns + index ship as an idempotent SQL file
(not the Publish diff alone) because drizzle push aborts on unrelated pre-existing
`conditions_met` drift, which would skip all additive changes.
