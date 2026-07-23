---
name: Grouped create-gift → optional allocation split
description: Minting a NEW gift from a source group can seed one allocation per grouped staged payment, or stay header-only.
---

# Grouped create-gift: split subcomponents into allocations

**STATUS (2026-07-23): HISTORICAL.** Unit groups are fully retired
(`docs/adr-linear-money-model.md` §7 step 3 done) — the group-aware
card-approve path, `card.isSourceGroup`, and `splitGroupIntoAllocations` no
longer exist. Kept only as context for legacy data minted through this path.

When the reconciliation workbench mints a NEW gift from a source group (the
`create_gift` outcome on a `card.isSourceGroup`, routed through the group-aware
card-approve path — NOT per-row create), the operator is now asked whether each
grouped staged payment should become its own allocation row on the new gift.

- **Yes (split):** one `gift_allocations` row per group member, `sub_amount` =
  that member's amount, `entityId` = the member's attributed `staged_payments.entity_id`.
  Member amounts sum to the group total by construction, so NO proportional
  scaling is needed (unlike `copyPledgeAllocationsToGift`, which scales pledge
  lines to the payment). Scope beyond entity is left for the fundraiser to refine;
  restriction axes / counts-toward-goal fall back to their NOT-NULL defaults.
- **No:** header-only lump (the prior behavior). Either way the gift amount = the
  group total.

**Why this correction matters:** the grouped mint used to be *unconditionally*
header-only. It is now header-only-by-default with an opt-in split.

**Wiring (contract-first):** the choice is a nullable `splitGroupIntoAllocations`
boolean on `ApproveCompleteMatchBody` (OpenAPI → codegen → implement). It only
does anything on a create_gift group mint with NO opportunity — the opportunity
outcomes seed allocations from the pledge instead, so the flag is ignored there.
The group members query in the approve route must select `entity_id` (not just
id+amount) to seed the allocation entity; `GroupMintContext` / `mintGiftInTx`'s
`group` arg carry the per-member `{id, amount, entityId}` rows + the flag.
Stripe-backed groups are still rejected (`source_group_stripe_unsupported`), so a
split group never has a charge.
