---
name: Donorbox pull-sync money model
description: How Donorbox donations flow into the CRM — Stripe-type enrich only, non-Stripe human-reviewed, never staged_payments.
---

# Donorbox pull-sync money model

Donorbox is a pull-only money source (advisory lock SOURCE_TAG=5, non-destructive
upsert mirroring the Stripe-sync `setWhere status in ('pending','excluded')`
pattern that preserves review state and refreshes only read-only facts).

Two outcomes, split on whether the donation has a Stripe charge id
(`stripe_charge_id` = `ch_...` = the `stripe_staged_charges.id`):

1. **Stripe-type ⇒ ENRICH ONLY, never mint.** Stripe sync already pulls those
   charges, so minting a gift from the Donorbox copy would double-count the same
   money. Stripe-type Donorbox rows only enrich existing records/gifts
   (campaign, designation, comment, recurring, donor profile) via a join on
   `stripe_charge_id`.
2. **Non-Stripe (PayPal/ACH) ⇒ HUMAN-REVIEWED candidate, never auto-mint.** They
   surface in the Donorbox review queue (`/donorbox-review`). Reviewer can
   link-gift / create-gift / exclude. **Never insert into `staged_payments`** —
   that table is QuickBooks-semantic; Donorbox new-money is its own lane.

**Why:** keeping these lanes separate is what prevents the same dollar from being
booked twice across Stripe sync, QuickBooks staging, and Donorbox.

**How to apply (create-gift path):**
- Dedupe (`findDonorboxDuplicates`, amount+date / paypal txn) is **advisory** —
  display-only, `force=true` overrides it. Do not promote it to a hard
  uniqueness guard; there's no hard invariant on PayPal txn id.
- The mint runs in a txn that re-locks the row `FOR UPDATE` and re-checks
  status/stripe/link guards — this is what actually prevents a same-row double
  mint. Donor XOR re-validated post-lock (`validateGiftInvariants`).
- A created gift is a plain CRM gift with **no `finalAmountSource`**, so the
  live-derived QB tie (`deriveGiftQbTieLiveExpr`) classifies it `missing` until
  reconciled (surfaces in the QB-tie worklist) — intended.

**Merge coverage:** `donorbox_donations` donor FKs (`organization_id`,
`individual_giver_person_id`) are in the mergeEntities FK inventories so a donor
merge repoints them. `household_id` is intentionally uncovered — there is no
household merge config. The merge-config FK-inventory test fails on any new
donor FK that isn't registered.
