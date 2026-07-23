---
name: Counted-uniqueness per evidence anchor
description: One counted payment_applications row per evidence anchor — guard + partial unique indexes; effects on tests, seeds, and supersede flows.
---

# Counted-uniqueness per evidence anchor

**Rule:** Each evidence anchor (QB staged payment, Stripe charge, or Donorbox
donation) may carry at most ONE `link_role='counted'` payment_applications row.
Enforced twice:

1. Domain guard in the shared applier (`applyPaymentApplication`): throws
   `AnchorAlreadyCountedError` when the anchor already has a counted row for a
   DIFFERENT gift — regardless of amounts. Idempotent same-gift re-apply still
   upserts; re-point flows delete the old counted row earlier in the same tx.
2. DB backstop: three partial unique indexes
   (`payment_applications_<anchor>_counted_uq WHERE link_role='counted'`) —
   raw inserts and UPDATE promotions hit 23505.

Corroborating rows are exempt (any number per anchor).

**Why:** "Split one payment across gifts" was retired (gift-side split is a 410
tombstone; evidence-side split-units are the supported path — split the
evidence row into child units, then match each child 1:1). Multiple counted
rows per anchor double-count money and made every ledger read ambiguous.

**How to apply:**
- Never seed test/fixture data with two counted rows on one anchor — the
  insert itself now fails. Model "resolved by ledger" scenarios with ONE
  counted row per anchor.
- Supersede/promote paths (corroborating→counted UPDATE) must be prepared for
  23505 or pre-check; the charge-tie supersede conservatively skips the move
  when the charge is already counted for a different gift.
- The guard is source-generic (keyed on the anchor's ledger column), so a test
  on one anchor kind covers the shared code path; per-anchor 23505 backstop
  tests pin the indexes themselves.
