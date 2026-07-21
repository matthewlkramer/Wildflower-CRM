---
name: Gift QuickBooks tie status
description: The LIVE-derived gift↔QB tie (exempt|tied|amount_mismatch|missing) — no stored column, no applier, no recompute call sites; derivation rules and cutover history.
---

# Gift ↔ QuickBooks tie status

The tie (`exempt|tied|amount_mismatch|missing`) is **live-derived at read
time** by `deriveGiftQbTieLiveExpr()` / `deriveGiftQbTieLiveRaw()` in
`artifacts/api-server/src/lib/giftQbTie.ts`. The stored
`gifts_and_payments.quickbooks_tie_status` column and its applier
(`applyGiftQbTieMany`) were RETIRED — the column is dropped. There is no
recompute call site to add or maintain: mutation paths do NOT need a
tie-recompute step, and any doc or memory telling you to call an applier is
stale.

**Why:** the persisted+recompute model went silently stale whenever a mutation
path forgot its recompute call — an entire class of bug. Live derivation
removed every call site (one authority, zero recompute sites), consistent with
the reduction principle in `replit.md`.

**Derivation rules (durable decisions, unchanged by the cutover):**

- Exempt = `off_books_fiscal_sponsor OR designated_to_school` — exempt wins
  over everything.
- Amount compared with the reconciler's `amountWithinFeeBand` so the flag
  agrees with the reconcile gate. Can't prove a mismatch without both amounts
  ⇒ `tied`.
- Reads `payment_applications` `link_role='counted'` rows with **per-source
  precedence (qb > stripe > donorbox), NOT an all-source SUM** — a gift settled
  by both a coarse QB deposit line and its per-charge Stripe rows carries a
  counted row of each source; summing doubles the linked amount → false
  `amount_mismatch`. The all-source SUM becomes correct only once
  `settlement_links` reclassifies the coarse QB row to
  `link_role='corroborating'`.
- Stripe-sourced with no direct QB link ⇒ `tied` (money lands in QB at the
  payout level, not per-charge).
- On-books with no QB evidence ⇒ `missing`.

**How to apply:** per-source counted helpers live in `paymentApplications.ts`
(`{qb,stripe,donorbox}LedgerExistsForGift` / `…SumForGift`); each takes a
pre-qualified gift-id SQL expression (bare-column footgun — see
`drizzle-sql-template-bare-column.md`).

**Audit view:** off-books (exempt) gifts are EXCLUDED from the
`/audit-reconciliation` read view — return early with `auditExcluded:true`, do
not compute donor/QB-records/restrictions for them.
