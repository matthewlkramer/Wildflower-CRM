---
name: Split gift into pledge — design decisions
description: Non-obvious decisions behind the "split a multi-allocation gift into a pledge" gift-detail action.
---

# Split gift into pledge

Action: a gift with >= 2 allocations is converted to a PLEDGE + one payment-gift
per allocation. Transform-in-place — the ORIGINAL gift is kept as the payment for
its FIRST allocation; a new gift is minted for each remaining allocation and that
allocation row is re-pointed (its id preserved — it's a money-trail row).

## Decisions that aren't obvious from the code

- **Matching-gift relationships are intentionally NOT blocked.** A gift that
  participates in a matching-gift relationship (`giftBeingMatchedId`, or another
  gift pointing at it) can still be split. **Why:** the original gift persists
  with the same id, so every FK stays valid and nothing is corrupted; only the
  matched *amount* becomes semantically stale (the original now holds just its
  first allocation). Blocking would surprise users for no integrity gain.
  **How to apply:** don't add a matching-gift guard unless a concrete data-loss
  case appears; revisit only if matched-amount staleness becomes a real problem.

- **Pledge stage is derived, never the seed.** The route inserts the pledge with
  `stage: written_commitment` then calls `applyDerivedOppFieldsMany`. A fully-paid
  split (the payment-gifts sum to the awarded amount) immediately derives to
  `cash_in`. Assert/expect the DERIVED state, not the seeded one. (Consistent with
  the broader "opportunity status is calculated" rule.)

- **Lock the allocation rows, not just the gift.** The tx must
  `SELECT ... FOR UPDATE` the `gift_allocations` rows too — locking only the parent
  gift leaves a window where a concurrent edit to an allocation's sub-amount slips
  between the cents-exact sum check and the re-point, desyncing a gift header from
  its allocation. **Why:** allocation edits don't change `gift_id`, so the parent
  lock doesn't cover them.

- **QB/thank-you/Airtable/archive metadata stays only on the original gift;**
  minted gifts carry donor, date, method, amount, owner, tags, contacts,
  intermediary, and an allocation-aware `grantYear` + `designatedToSchool`. Minted
  gifts deliberately carry NO QuickBooks links. Splitting a QB-linked gift is a
  hard 409 (staged-payment match links + staged_payment_splits).
