---
name: payment_applications corroborating vs counted link_role
description: Every payment_applications reader must filter link_role='counted'; corroborating rows are audit-only and must never enter a money read.
---

# `payment_applications.link_role` — counted vs corroborating

`payment_applications` (PA) is the unified unit↔gift ledger. Phase 5 folded the
old FK-less `gift_evidence_links` (gel) table INTO it as `link_role='corroborating'`
rows (design doc §5 Decision 2). So PA now holds two kinds of row:

- `counted` — the money trail. `amount_applied` is NOT NULL and > 0. Included in
  every SUM / tie / settled derivation.
- `corroborating` — an audit annotation (a gift↔evidence link that does NOT book
  money). `amount_applied` is NULL. Must NEVER enter a money total.

## The rule

**Every read of `payment_applications` that feeds a money total, a "has a payment
landed?" check, or a tie/settled derivation MUST filter `link_role = 'counted'`.**
The role-scoped partial uniques and the role-aware `amount_applied` CHECK enforce
write shape, but reads are plain SQL — nothing stops a query from summing/【EXISTS】-ing
across both roles.

**Why:** A code review caught a real leak — `giftPaymentSummary.ts`
(`settledGrossForGift`, `hasLinkedPaymentForGift`) filtered only
`evidence_source='quickbooks'`, not `link_role='counted'`. A gift whose ONLY PA
row was corroborating (exactly what the corrections `/apply` flow and the 0090
backfill produce) flipped `hasLinkedPayment` TRUE, changing `derivedSettledAmount`
from NULL ("nothing landed yet") to '0' ("settled $0") — the precise distinction
that read model exists to preserve. No counted SUM moved a dollar (corroborating
amount is NULL), but it silently corrupted a derived money surface the moment the
dual-write/backfill ran.

**How to apply:** When adding or reviewing any PA reader, grep for
`payment_applications` and confirm each one carries `link_role = 'counted'` (the
helpers in `artifacts/api-server/src/lib/paymentApplications.ts` already do; the
raw subqueries in `giftPaymentSummary.ts` now do too). The regression guard is the
"corroborating links stay out of the settled read model" test in
`financialCorrections.integration.test.ts` (corroborating-only gift ⇒
`derivedSettledAmount` NULL).

## Related

The corroborating rows have their own per-anchor partial uniques
(`..._corroborating_uq`, partial on `link_role='corroborating'`), DISJOINT from the
counted book-once uniques, so a counted and a corroborating row for the same
(anchor, gift) coexist. Dual-write (corrections `/apply`) and re-home (gift
combine) keep gel and its corroborating PA twin in lockstep; the
`parity:gift-evidence-links` script is the bidirectional gate that must pass on
PROD before the Phase-5 read-flip (which switches gel readers to the ledger).
