---
name: Reconciliation single-source-of-truth (D4 model)
description: CRM gifts are the only gifts; Stripe/QB rows are permanent evidence — the model that REPLACED confirm-time archiving + processor_payout exclusion.
---

# Reconciliation: CRM gifts are the single source of truth

**The model (current):** `gifts_and_payments` rows are the ONLY gifts. Stripe
charges/payouts and QB staged rows are reconciliation **evidence**, tied
permanently to a gift — they are NEVER themselves gifts and are NEVER archived.
`gifts.amount` holds the REAL final amount (downstream keeps reading `amount`).
Provenance lives in `final_amount_source` (`human` | `stripe` | `quickbooks`)
with an XOR pointer (`final_amount_stripe_charge_id` / `final_amount_qb_staged_payment_id`);
`original_human_crm_amount` snapshots the pre-stamp human value once.

**Stripe GROSS wins.** When a Stripe charge exists for the money, its gross is
authoritative; QB only sources the amount when there is no Stripe charge.
`stampGiftFinalAmount(tx, giftId, {source:'quickbooks',...})` is a **no-op
(`skipped:true`)** when the gift is already Stripe-sourced. Both QB reconcile
paths (single + group, `routes/quickbooks/matching.ts`) guard on `!stamp.skipped`
before adjusting allocations. Regression: quickbooks-group-reconcile
"leaves a Stripe-sourced gift's final amount untouched when QB reconciles".

**On confirm:** stamp the gift + mark the evidence row `reconciled` (the shared
`staged_payment_status` value used by both QB staged_payments and
stripe_staged_charges); payout → `confirmed_reconciled`. Minting new gifts stays
**human-only** in this build.

**Why / what this REPLACED:** the pre-D4 model archived the coarse QB-derived
gift and excluded the deposit with `processor_payout` on confirm. D4 retired
both: confirm no longer archives gifts and no longer sets `processor_payout`;
`confirm-replace` is retired and returns `manual_review_required` (409). The old
enum values (`confirmed_excluded` / `confirmed_keep` / `confirmed_replace`,
`processor_payout`) are KEPT only to REVERT pre-D4 rows — do not reintroduce them
on the confirm path. Route paths (`/confirm-exclude`, `/confirm-keep`,
`/confirm-replace`) are kept for client compatibility but their behavior changed
(exclude/keep now both → `confirmed_reconciled`).

**How to apply:** any new code that books reconciled money must write the gift
and stamp provenance — never create a parallel "gift" out of a Stripe/QB row,
never archive a gift to dedupe money, never re-add processor_payout. FKs from
gift → staged/charge are RESTRICT by design (clear the gift pointer before
deleting evidence, e.g. in test teardown).
