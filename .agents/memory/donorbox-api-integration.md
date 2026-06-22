---
name: Donorbox API integration
description: Donorbox API shape, auth, and the join key to Stripe staged charges — read before any Donorbox enrichment/ingestion work.
---

Donorbox is a donation-form front end that processes card donations THROUGH the
org's connected Stripe account (and optionally PayPal). Before any direct
integration, know:

- **Auth**: HTTP Basic. Username = the org's Donorbox **login email**, password =
  the API key. The `DONORBOX_API_KEY` secret ALONE is not enough — you also need
  the login email (store as e.g. `DONORBOX_API_EMAIL`). API access is a paid
  (~$17/mo) Donorbox add-on, so a valid key still 401s if the add-on lapsed.
- **Base URL**: `https://donorbox.org/api/v1`. Endpoints: `/campaigns`,
  `/donations`, `/donors`, `/plans` (recurring), `/events`, `/tickets`.
  Pagination `page` + `per_page` (default 50, max 100), `order=asc|desc`.
  Webhooks exist as an alternative to polling.
- **Join key (the key fact)**: a Stripe-type donation carries
  `stripe_charge_id` = `ch_...`, which is EXACTLY `stripe_staged_charges.id`
  (that table's PK *is* the Stripe charge id). So Donorbox→Stripe is a clean 1:1
  join, no fuzzy matching. `donation_type` distinguishes `stripe` vs `paypal`.
  PayPal donations carry `paypal_transaction_id` (NO Stripe charge) and are
  therefore money the Stripe sync never sees — genuinely new. There is NO
  `payment_intent_id` (pi_...) — only the charge id.
- **What Donorbox adds over the raw Stripe charge** (Stripe only has money + thin
  payer/description text): `campaign{id,name}`, `designation` (fund/cause),
  `comment`, `recurring`/`first_recurring_donation` + full `/plans` structure,
  `processing_fee` (fee-cover), full donor profile (name, address, employer,
  occupation, phone), `anonymous_donation`, `gift_aid`, `donating_company`,
  `utm_*`, and custom `questions[]`.

**Why:** today the CRM only "knows" Donorbox via a regex (`/donor\s?box/i`) on
Stripe/QB memo text that sets `funding_source=donorbox`; there is no real feed.
The right design is enrichment keyed on `stripe_charge_id` (NOT a parallel money
pipe — re-ingesting Stripe-type donations as gifts would double-count the charges
the Stripe sync already pulls), with separate staging only for PayPal/non-Stripe
donations.

**How to apply:** when building Donorbox ingestion, request the login email first
(you can't even test the key without it); enrich existing
stripe_staged_charges/gifts by `stripe_charge_id`; only stage NEW review rows for
`donation_type != "stripe"`. Mirror the existing pull-only, advisory-locked,
non-destructive worker pattern (stripeSync / quickbooksSync).
