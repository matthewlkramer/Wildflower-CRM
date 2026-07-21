---
name: Stripe charge donor crossing propagates to gift links
description: A wrong confirmed donor on a Stripe charge deterministically proposes the wrong donor's gift; out-of-band link repairs must mirror the app's FULL link write-set.
---

**Rule:** The charge card's gift-proposal pool (`unlinkedChargeGiftWhere`, cards.ts) is scoped to the CHARGE's confirmed donor pointer. If the donor on a charge is wrong (e.g. QB mislabeled the payer and a reviewer confirmed it), every subsequent proposal/link on that card follows the crossed donor — the UI can never surface the right gift. Fix the donor pointer first; the gift link is downstream.

**Why:** Twin same-amount charges (two $156.48 charges → twin $148.90 payouts/deposits) plus a QB payer mislabel crossed Rue's charge onto Kirby's gift. The reviewer's confirm was "correct" given what the (donor-scoped) card proposed. The wrong link then blocked the other charge with 409 link_conflict (gift owned by another charge via the partial-unique `matched_gift_id` + counted book-once key).

**How to apply (out-of-band repair must mirror the app's full link write-set):**
1. payment_applications counted/confirmed row (amount = charge GROSS per bookStripeChargeApplication).
2. Charge row stamps: matched_gift_id, match_status='matched', match_confirmed_by/at, approved_by/at (see reconciliationBundleCommit).
3. Gift final-amount provenance: final_amount_source='stripe' + final_amount_stripe_charge_id (stampGiftFinalAmount; Stripe overwrites 'human'; amount itself untouched).
4. QB-tie signal — it is NOT QB-only: the live-derived tie (deriveGiftQbTieLiveExpr; no recompute step) reads counted Stripe rows with per-source precedence (QB > Stripe > Donorbox), so a gift gaining/losing a Stripe counted row changes its tie (156.48 vs 156.00 → amount_mismatch).
5. Ordering vs partial uniques: move the wrong charge's pointers OFF the gift before the right charge claims it (matched_gift_id_uq + counted (charge,gift) key are checked per-statement even inside one txn).

Precedent repair file: lib/db/migrations/0124_swap_rue_kirby_crossed_charge_gift_links.sql (guards double as prod pre-flight checks — each statement no-ops unless the exact wrong state still holds).
