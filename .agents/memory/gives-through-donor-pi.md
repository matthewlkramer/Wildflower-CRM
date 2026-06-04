---
name: Gives-through donor→payment-intermediary links
description: How donors (org/individual/household) link the payment intermediaries they give through, replacing the old single org PI picker.
---

# "Gives through" donor → payment-intermediary links

A many-to-one-per-pair join table links a **donor** to the payment
intermediaries (fiscal sponsors / DAFs) it gives through. A shared
`GivesThroughCard` renders on all three donor detail pages
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

## Idempotent create
Partial unique indexes (one per donor type) guarantee one
`(donor, intermediary)` row. POST uses `onConflictDoNothing()` and, on
conflict, re-resolves and returns the existing row (no 500 on re-add).

## giftDerived suggestions
List endpoint returns `{ data, giftDerived }`. `giftDerived` = intermediaries
seen on the donor's own gifts but **not yet logged** (excluded via
`notInArray(..., loggedPiIds)`). The card surfaces these as "Seen on gifts —
add?" quick-adds, and also excludes `loggedIds` from the add-combobox so you
can't double-add.

## Deprecated column, not dropped
`organizations.payment_intermediary_id` (the old single-PI picker) is
**retained/deprecated**, not dropped — the old picker UI was removed but the
column stays for back-compat / future backfill audit. The 0008 migration is
additive + idempotent and backfills deterministic IDs from that column with
`ON CONFLICT DO NOTHING`.

**How to apply:** when adding donor-scoped link features, reuse the donor-XOR
helpers and the partial-unique-index + onConflictDoNothing idempotency pattern;
invalidate with the donor-scoped generated query key after mutations.
