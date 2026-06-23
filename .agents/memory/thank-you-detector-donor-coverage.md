---
name: Thank-you/acknowledgment detector donor coverage
description: The outbound thank-you detector links gifts for ALL three donor kinds; accept path is donor-agnostic.
---

# Thank-you / acknowledgment detector — donor coverage

The outbound thank-you detector resolves email recipients to ALL THREE donor
kinds a gift can carry under Donor XOR (organization, individual giver,
household), then proposes a link for each unlinked candidate gift. It originally
resolved organizations only, so thank-yous to individual/household donors were
never linked.

**Why it matters / constraints to preserve:**
- `email_proposals` has person + organization target columns but **no household
  target column** — household donor identity for a proposal lives only in the
  proposal `payload`. Don't assume a household target column exists.
- The accept/link path is donor-type agnostic: it links by the gift id in the
  proposal payload, not by donor type. Keep it that way — don't special-case
  donor type on accept.
- Detection gating that must stay intact: document attachment present + "thank"
  in subject + the ±30-day window + skip already-linked gifts + one proposal per
  candidate gift.
