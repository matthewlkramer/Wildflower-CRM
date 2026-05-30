---
name: Donor XOR across split pickers
description: How to keep the gift/opp donor XOR invariant safe when the donor is edited from separate per-type pickers instead of the composite InlineEditDonor.
---

On gift-detail the donor (funderId | individualGiverPersonId | householdId,
DB-enforced exactly-one XOR) is edited from THREE separate pickers split across
the Organizations card (Funder, Household) and People card (Individual donor),
not the composite InlineEditDonor.

Rule: each donor setter must send ALL THREE FK fields, setting the two
non-selected to null, and the pickers must use `allowNull={false}`.

**Why:** the server (validateGiftInvariants/validateOppInvariants) requires
exactly one donor populated. Separate pickers that only send their own field
could leave two set (→400) or clear to zero (→400). Sending all three + no-null
keeps exactly one populated at all times. Payment intermediary and advisor are
NOT part of the XOR and stay independent (allowNull ok).

**How to apply:** reuse this pattern for any detail page that decomposes a
donor/XOR group into per-entity pickers. The composite InlineEditDonor already
does this internally; mirror its buildDonorBody behavior.
