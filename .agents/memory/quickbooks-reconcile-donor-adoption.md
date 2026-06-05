---
name: QuickBooks reconcile adopts gift donor
description: Explicit human Match links staged payment to a gift by adopting the gift's donor
---

The QuickBooks staged-payment reconcile endpoint (link to an EXISTING gift)
treats an explicit human Match as authoritative: the staged row **adopts the
selected gift's donor**, overriding any auto-guessed donor.

**Why:** a deposit line auto-matched to an individual (e.g. "Angie Schiavoni")
could not be linked to that person's *household* gift — the old strict
`donorsMatch` guard returned HTTP 400 `donor_mismatch`. The fundraiser explicitly
selects both sides, so their selection wins. (User decision, confirmed.)

**How to apply:** reconcile sets `finalDonor = giftDonor`; the only donor guard
left is `hasExactlyOneDonor(giftDonor)` (keeps Donor XOR on the staged row).
`donorsMatch` / `validateGiftLink` in `quickbooksLink.ts` are now legacy — still
exported + unit-tested but NOT enforced by the reconcile route. Do not
reintroduce a strict staged-vs-gift donor-equality check on the explicit Match
path. The atomic `NOT EXISTS` update + 23505 → 409 race handling is unchanged.
