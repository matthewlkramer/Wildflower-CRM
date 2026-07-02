---
name: Gift scope → allocation migration
description: Moving gift scope/reconciliation state off the gifts_and_payments header onto allocations or read-time derivation; what's derived, what's still deprecated-but-present.
---

# Gift scope off the header → allocations / derivation

Goal: gift scope + reconciliation state lives on child `gift_allocations` rows or
is DERIVED at read time from linked payments, NOT on the `gifts_and_payments`
header. Deprecate-then-drop (columns stay + still written until a prod backfill +
drop lands).

## The one settled/fees + off-books derivation
`artifacts/api-server/src/lib/giftPaymentSummary.ts` is the SINGLE source for:
- `settledGrossForGift` / `totalFeesForGift` / `hasLinkedPaymentForGift` — derived
  from QB `payment_applications` (fee 0) + Stripe `stripe_staged_charges`
  (gross/fee) + non-stripe `donorbox_donations`. Stripe-type Donorbox excluded
  (double-count). Read-model projections `derivedSettledAmountForGift` /
  `derivedProcessorFeeForGift` (nullable).
- `giftIsOffBooksExpr` / `giftExpectsPaymentExpr` — a gift is off-books/exempt
  exactly when it has ≥1 allocation AND every allocation sits on a no-payment
  entity (`entities.expects_payment = false`). This ONE rule collapses the three
  retired header flags: `designated_to_school` → the `direct_to_school` entity,
  `off_books_fiscal_sponsor` → the `wildflower_foundation_tsne` entity, and
  `payment_expected` → derived.

All exprs follow the bare-column footgun rule: pass a literal pre-qualified
gift-id SQL expr, never an interpolated drizzle Column.

**Why:** keep derived read fields and the reconciliation queue from ever
disagreeing about "what settled" / "is this exempt".

## Transitional OR (remove when columns drop)
`giftIsOffBooksExpr` ORs in the legacy header flags
(`off_books_fiscal_sponsor OR designated_to_school OR NOT payment_expected`) so
exemption stays correct for rows not yet migrated by the Step-12 prod backfill.
Validated on dev: derived off-books == legacy off-books (49==49).

## stamp no longer rewrites amount
`stampGiftFinalAmount` (giftFinalAmount.ts) no longer overwrites the human-entered
`amount`/`processor_fee`/`original_human_crm_amount` — neither the QB path (Phase-2
ledger) nor now the Stripe path. It only records the (deprecated) provenance
pointer and returns `changed:false`, so every caller's
`adjustSingleAllocationOrFlag` no-ops. Settled-vs-entered disagreement is meant to
surface in the reconciliation queue, not silently rescale allocations. Auto-minted
Stripe gifts are still BORN with amount=gross (no human figure to overwrite).

**Stale-red tests (not a regression):** two `reconciliation-approve.integration.test.ts`
cases under "single-source-of-truth invariants" still assert the OLD
stamp-rewrites-to-gross amount and fail on an unmodified HEAD.
**Why:** they were never updated when confirm stopped rewriting `gift.amount`, so
edits to the approve/commit path get wrongly blamed for them.
**How to apply:** before treating an approve/commit test failure as your own
regression, confirm the same case already fails on unmodified HEAD.

## Still header-resident (not yet migrated as of this writing)
- `type` (giftTypeEnum) — still read/written in giftsAndPayments routes via
  `giftTypeToLoanOrGrant`; intended to be DERIVED (pledge_payment⇐opportunityId,
  directed⇐advisorPersonId, matching⇐giftBeingMatchedId, loan⇐loanOrGrant='loan',
  else standard).
- `quickbooks_tie_status` + `giftQbTie.ts` applier + lanes/audit/list-filter/detail
  badge — intended for full removal (re-derive lanes without it).
- grant_year + counts_toward_goal header cols: reads ALREADY use allocations
  (`ga.n`, 0080 moved counts_toward_goal); header cols deprecated, await drop.

## Migrations
- `0081_gift_scope_fund_dimensions_seed.sql` (+RUNBOOK) — seeds `expects_payment`,
  the two no-payment entities, and `seed_fund` project. Run AFTER Publish.
- Data backfill (header designations → allocation entities; ambiguous →
  needs_research; off-books → TSNE) is a separate later migration (Step 12).
