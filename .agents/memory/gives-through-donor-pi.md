---
name: Gives-through donor→payment-intermediary links
description: How donors (org/individual/household) link the payment intermediaries they give through, replacing the old single org PI picker.
---

# Donor → payment-intermediary links

A many-to-one-per-pair join table links a **donor** to the payment
intermediaries (fiscal sponsors / DAFs) it gives through. A shared
`GivesThroughCard` renders as **Payment intermediaries** on all three donor detail pages
(organization, individual, household).

## Donor XOR — same invariant family as opportunities/gifts

Each link row carries exactly one donor FK: `organization_id`,
`individual_giver_person_id`, or `household_id`. Enforced at **all three**
layers, matching the existing donor-XOR pattern:

- DB CHECK (`num_nonnulls(...) = 1`).
- API: GET and POST normalize donor fields and reject non-XOR via the same
  `validateGiftInvariants` / `DONOR_XOR_MESSAGE` helpers used by gifts.
- UI: each page passes exactly one donor key into `GivesThroughCard`.

**Why:** keeps "who is the donor" unambiguous and consistent with
opportunities/gifts so reporting can union donor scopes safely.

## Durable pair identity and archive/restore

Partial unique indexes (one per donor type) guarantee one
`(donor, intermediary)` row across its lifetime. Removing a link sets
`archived_at` and clears `is_default`; POST restores the same row on re-add.
Hard delete is not an application operation.

Each donor can have at most one active `is_default` relationship. Archived
links and links to archived payment intermediaries are excluded. For a new
gift, the source record's explicit default wins and the resolved donor of
record's default is the fallback. The database function
`resolve_default_payment_intermediary` is shared by the read API and gift
trigger.

## giftDerived suggestions

List endpoint returns active `data`, `giftDerived`, and the effective default
plus its source. `giftDerived` = intermediaries
seen on the donor's own gifts but **not yet logged** (excluded via
`notInArray(..., loggedPiIds)`). Archived relationship rows count as logged so
dismissed suggestions do not immediately reappear. The card surfaces new
suggestions as "Seen on gifts — add?" quick-adds.

## Retired legacy column

`organizations.payment_intermediary_id` was dropped in migration 0146 after
the many-to-many relationship became authoritative. Do not reintroduce it.

**How to apply:** when adding donor-scoped link features, reuse the donor-XOR
helpers and the durable pair + archive/restore pattern;
invalidate with the donor-scoped generated query key after mutations.
