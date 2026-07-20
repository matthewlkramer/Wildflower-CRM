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
  entity (`entities.expects_payment = false`: `direct_to_school` /
  `wildflower_foundation_tsne`). A gift with NO allocations is ON-books. This ONE
  allocation-only rule fully REPLACES the three now-dropped header flags:
  `designated_to_school` → the `direct_to_school` entity, `off_books_fiscal_sponsor`
  → the `wildflower_foundation_tsne` entity, and `payment_expected` → derived. Do
  NOT reintroduce header booleans for off-books; entities are the sole input.

All exprs follow the bare-column footgun rule: pass a literal pre-qualified
gift-id SQL expr, never an interpolated drizzle Column.

**Why:** keep derived read fields and the reconciliation queue from ever
disagreeing about "what settled" / "is this exempt".

## Header flags fully retired (transitional OR removed)
`giftIsOffBooksExpr` no longer ORs in any header flag — it is purely
allocation-only. The 3 header columns (`payment_expected`,
`off_books_fiscal_sponsor`, `designated_to_school`) are removed from Drizzle and
dropped in prod/dev via `0104`. Ordering: Publish the read-stop code FIRST (both
DBs still hold the columns → clean diff), then run `0103` (data backfill) and
`0104` (drop) back-to-back; NEVER Publish between them.
**49 designated pass-through decision:** all 49 legacy `designated_to_school`
gifts sat on `wildflower_foundation` (expects_payment=TRUE) → `0103` repoints them
to `direct_to_school` so they STAY off-books (zero on/off flips). An allocation's
`school_recipient_id` on `wildflower_foundation` is an independent ON-books concept
— do NOT conflate it with off-books; leave it untouched.

## stamp no longer rewrites amount
`stampGiftFinalAmount` (giftFinalAmount.ts) no longer overwrites the human-entered
`amount`/`processor_fee`/`original_human_crm_amount` — neither the QB path (Phase-2
ledger) nor now the Stripe path. It only records the (deprecated) provenance
pointer and returns `changed:false`, so every caller's
`adjustSingleAllocationOrFlag` no-ops. Settled-vs-entered disagreement is meant to
surface in the reconciliation queue, not silently rescale allocations. Auto-minted
Stripe gifts are still BORN with amount=gross (no human figure to overwrite).

**Stale-red integration tests:** as of 2026-07 the full api-server suite (99 files,
1278 tests) is GREEN. The two formerly-pre-existing failures mentioned here were
fixed and removed — do not treat any test failure as "pre-existing" without
re-verifying against the current HEAD count (1278 passing).

## Still header-resident (not yet migrated as of this writing)
- grant_year + counts_toward_goal header cols: reads ALREADY use allocations
  (`ga.n`, 0080 moved counts_toward_goal); header cols deprecated, await drop.

## Completed header retirements
- `type`, `quickbooks_tie_status`, `final_amount_stripe_charge_id`, four
  `coding_form_*` cols — DROPPED in migration 0140 (2026-07). `type` is now fully
  derived from payment_applications links at read time via `giftTypeDerived.ts`;
  `quickbooks_tie_status` is derived live from payment_applications (no write-back).
  `loanOrGrant` is now the direct write-body field (in Create/Update/Bulk bodies).
  `giftQbTie.ts` no longer writes to DB — it only reads.

## Migrations
- `0081_gift_scope_fund_dimensions_seed.sql` (+RUNBOOK) — seeds `expects_payment`,
  the two no-payment entities, and `seed_fund` project. Run AFTER Publish.
- `0103_backfill_offbooks_to_allocation_entities.sql` (+RUNBOOK) — idempotent DATA
  backfill: seeds the 2 no-pay entities (dev lacked BOTH), repoints designated →
  `direct_to_school` + fiscal-sponsor → `wildflower_foundation_tsne`; step-4
  flip-guard mirrors `giftIsOffBooksExpr`. Run before `0104`.
- `0104_drop_gift_offbooks_header_cols.sql` (+RUNBOOK) — DROPs the 3 header columns.
  Publish read-stop code first, then 0103 then 0104 back-to-back, no Publish between.
- Apply prod DATA files with `psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f
  lib/db/migrations/<file>.sql` (no BEGIN/COMMIT inside a `-1` file).
