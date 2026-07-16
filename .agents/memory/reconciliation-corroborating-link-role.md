---
name: payment_applications corroborating vs counted link_role
description: Every payment_applications reader must filter link_role='counted'; corroborating rows are excluded from all money totals. Two distinct corroborating sub-cases exist.
---

# `payment_applications.link_role` — counted vs corroborating

`payment_applications` (PA) is the unified unit↔gift ledger. PA holds two kinds of row:

- `counted` — the money trail. `amount_applied` is NOT NULL and > 0. Included in
  every SUM / tie / settled derivation.
- `corroborating` — excluded from every money total. Must NEVER enter a money SUM,
  a "has a payment landed?" check, or a tie/settled derivation.

## The rule

**Every read of `payment_applications` that feeds a money total, a "has a payment
landed?" check, or a tie/settled derivation MUST filter `link_role = 'counted'`.**
The role-scoped partial uniques and the role-aware `amount_applied` CHECK enforce
write shape, but reads are plain SQL — nothing stops a query from summing/EXISTS-ing
across both roles.

**Why:** A code review caught a real leak — `giftPaymentSummary.ts`
(`settledGrossForGift`, `hasLinkedPaymentForGift`) filtered only
`evidence_source='quickbooks'`, not `link_role='counted'`. A gift whose ONLY PA
row was corroborating flipped `hasLinkedPayment` TRUE, changing `derivedSettledAmount`
from NULL ("nothing landed yet") to '0' ("settled $0") — corrupting the derived money
surface without moving a dollar. No counted SUM moved a dollar (corroborating amount
is NULL in the annotation case), but it silently broke the distinction the read
model exists to preserve.

## Two distinct corroborating sub-cases

**Sub-case A — Audit annotation (corrections flow / gel-fold):**
`amount_applied IS NULL`. A gift↔evidence link that does NOT represent money. Written
by the corrections `/apply` flow and the Phase-5 `gift_evidence_links` fold (0090
backfill). These rows are re-derivable and droppable on gift delete.

**Sub-case B — Supersede-demoted counted row (charge-tie supersede):**
`amount_applied IS NOT NULL`. A QB counted PA row that was demoted to `corroborating`
when a charge-grain tie was confirmed (`chargeTieSupersede.ts`). The amount is
intentionally KEPT for reversible promotion back to `counted` on revert — the row
must NOT enter any money total while corroborating. A half-moved state (QB row already
corroborating but no charge-grain counted row yet) is converged by the supersede flow
on next confirm. `link_role='counted'` filter correctly excludes sub-case B from money
reads even though `amount_applied` is non-null.

**How to distinguish them:** sub-case B rows carry a `note` field starting with
`charge_tie_supersede:<qbStagedPaymentId>` — the supersede flow writes this
deterministically. Sub-case A rows have `amount_applied IS NULL`.

> **Technical debt:** The `note` prefix `charge_tie_supersede:<qbStagedPaymentId>` is
> transitional executable state — `chargeTieSupersede.ts` writes it deterministically
> to identify demoted rows. It must be **replaced by structured `source_links`
> provenance** once `source_links` ships (ADR in `docs/adr-source-link-ledger.md`).
> Until then, do not add new code that reads or writes this note prefix outside the
> supersede flow itself.

## How to apply

When adding or reviewing any PA reader:
1. Confirm each query that feeds money totals carries `link_role = 'counted'`.
   The helpers in `artifacts/api-server/src/lib/paymentApplications.ts` already do;
   raw subqueries in `giftPaymentSummary.ts` now do too.
2. The regression guard is the "corroborating links stay out of the settled read model"
   test in `financialCorrections.integration.test.ts` (corroborating-only gift ⇒
   `derivedSettledAmount` NULL).
3. Do NOT use `amount_applied IS NULL` as the corroborating guard in reads — that
   misses sub-case B (non-null amount, still corroborating).

## Related

- Corroborating rows have per-anchor partial uniques (`..._corroborating_uq`, partial
  on `link_role='corroborating'`), DISJOINT from the counted book-once uniques, so
  a counted and a corroborating row for the same (anchor, gift) coexist legally.
- `gift_evidence_links` (gel) is DROPPED (migration 0091). The corroborating PA
  ledger is the ONLY home for audit evidence↔gift links.
- Prod DROP ships via Publish (schema diff); reviewed-idempotent-SQL-file rule
  (replit.md §7) covers prod DATA changes, not DDL.
