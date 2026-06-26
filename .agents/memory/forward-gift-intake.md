---
name: Forward gift intake (reconciliation → gift)
description: How the reconciliation workbench seeds gifts from pledges (suggestions, allocation copy, dup guard) — suggest-and-confirm only.
---

The reconciliation workbench is *forward gift intake*: it helps mint a gift from
incoming money and seed its scope from the pledge it pays — but never auto-applies.
Everything is suggest-and-confirm (a human approves each card).

**Donor-derived opportunity SUGGESTIONS** (reconciliationGraph `loadDonorOpps`):
once a donor resolves, suggestions must be MATERIALLY LIKELY, not every open opp.
Two plausibility layers (don't drop either — a reviewer code-review rejected
donor-only suggestions):
1. status filter — only still-COLLECTIBLE opps; exclude `cash_in/dormant/lost`
   (null status kept).
2. amount/date discipline (mirrors gift matching) — drop opps whose remaining
   collectible (`awarded − paid`, paid = SUM non-archived linked gifts) is < the
   incoming payment beyond the processor-fee band (`remaining*1.1+1`); enforced
   only when both the evidence amount and an awarded total exist (open un-awarded
   opps can't be assessed → kept as lower-ranked first-payment candidates).
**Why date is RANKING-only, never a filter:** pledge installments legitimately
span time, so a date band would wrongly drop valid later payments.
Ranking: written pledges first (prime payment-on-pledge target, tagged source
`payment_on_pledge` → "on pledge" badge; others `manual`), then amount-fit
confidence (final/full payment ≈ remaining/awarded scores highest, partial
installment lower but plausible), then nearest expected-payment date
(`pledge_allocations.expected_payment_date`), then name. A reviewer who needs a
closed/other opp still finds it via the manual opportunity text search.

**Allocation COPY on mint** (approve.ts `copyPledgeAllocationsToGift`): when a gift
is minted against an opp (the opportunity outcomes — `opp` loaded), copy the opp's
`pledge_allocations` → `gift_allocations`, PROPORTIONALLY scaled to the payment
(`scale = giftAmount / pledgeTotal`) so installments/partials inherit scope.
**Why proportional:** one payment is usually a slice of a larger pledge.
**Last row absorbs the remainder** so the copy sums EXACTLY to the gift amount
(header == sum(allocations) invariant). No pledge allocations ⇒ header-only gift
(no regression). Copy only the intersection columns (subAmount, grantYear,
entityId, intendedUsage, fundableProjectId, schoolRecipientId, the 3 restriction
axes, reimbursementType, regionIds, purposeVerbatim). NEVER copy pledge-only
fields (conditions/conditional/contingent/expectedPaymentDate/status/directToSchool)
or @deprecated coding; let `display_usage` be trigger-computed.

**Re-derivation is already wired** post-commit on the mint path —
`applyPaymentApplication` + `applyDerivedOppFieldsMany(opportunityId)` +
`applyGiftQbTieMany(newGiftId)` recompute pledge paid/committed/status + QB tie.
Don't re-add it.

**Manual-entry dup guard**: `GET /staged-payments-pending-for-donor`
(?donorType&donorId) returns pending staged money for a donor across BOTH sources
(staged_payments + stripe_staged_charges, status='pending'). The manual gift form
(gift-form-dialog) shows an amber warning when count > 0 so a fundraiser doesn't
hand-key money that's about to land via reconciliation.
