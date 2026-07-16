---
name: settlement_links model — durable constraints
description: Live structural facts about the settlement_links table after the legacy stripe_payouts recon mirror was dropped. (The old dual-write / parity machinery is retired.)
---

# settlement_links (Plane-1 Stripe payout ↔ QB deposit)

`settlement_links` is the SOLE authoritative store for the payout↔deposit tie; the
payout's reconciliation status is DERIVED on read (`payoutStatusFromLink` /
`payoutStatusLabelSql`). The legacy `stripe_payouts.qb_reconciliation_status` +
pointer mirror columns it replaced, the `deriveSettlementLinkFields` /
`reverseSettlementLink` dual-write, and the `parity:settlement-links` gate/script
have all been removed (columns dropped by migration 0093). The two facts below
outlive that machinery.

## conflict_approved has no lifecycle value — it is `proposed` + `conflict_gift_id`

The 3-value lifecycle (proposed|confirmed|exempt) can't hold the legacy
`conflict_approved` state (a proposal that landed on an already-booked QB gift). It
is represented as `lifecycle='proposed' AND conflict_gift_id IS NOT NULL` —
deliberately NOT a 4th lifecycle value (a 4th value would fork every lifecycle read,
e.g. `derivePayoutLanes`). `conflict_gift_id` (FK→gifts_and_payments, ON DELETE SET
NULL) is ALSO retained on a CONFIRMED link as the revert-of-keep discriminator +
double-book-guard input.

**Rule:** any writer MUST set/clear `conflict_gift_id` atomically with `lifecycle`
(`proposeSettlementLink` / `confirmSettlementLink` do). A stale conflict pointer on a
non-conflict link would mis-route the revert path and the double-book guard.

## deposit FK is ON DELETE SET NULL but a CHECK requires it — deletes error

`settlement_links.deposit_staged_payment_id` is `ON DELETE SET NULL`, yet
`settlement_links_deposit_required_chk` requires a non-`exempt` link to carry a
deposit. Postgres evaluates CHECKs during a referential SET NULL, so hard-deleting a
`staged_payments` row referenced by a `proposed`/`confirmed` link raises a CHECK
violation instead of nulling the pointer.

**How to apply:** latent today (archive-not-delete; no `delete(staged_payments)`
path), but any future staged-payment wipe/delete tooling must first clear or
re-`exempt` the referencing links.
