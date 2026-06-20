---
name: QuickBooks reconcile adopts gift donor
description: Explicit human Match links staged payment to a gift by adopting the gift's donor
---

The QuickBooks staged-payment reconcile endpoint (link to an EXISTING gift)
treats an explicit human Match as authoritative: the staged row **adopts the
selected gift's donor**, overriding any auto-guessed donor.

**Why:** a deposit line auto-matched to an individual (e.g. a person record)
could not be linked to that person's *household* gift — the old strict
`donorsMatch` guard returned HTTP 400 `donor_mismatch`. The fundraiser explicitly
selects both sides, so their selection wins. (User decision, confirmed.)

**How to apply:** reconcile sets `finalDonor = giftDonor`; the only donor guard
left is `hasExactlyOneDonor(giftDonor)` (keeps Donor XOR on the staged row).
`donorsMatch` / `validateGiftLink` in `quickbooksLink.ts` are now legacy — still
exported + unit-tested but NOT enforced by the reconcile route. Do not
reintroduce a strict staged-vs-gift donor-equality check on the explicit Match
path. The atomic `NOT EXISTS` update + 23505 → 409 race handling is unchanged.

**EXCEPTION — explicit "switch this gift's donor" (E7 reconciler):** the default
above adopts the gift's donor, but the E7 reconciliation card `link_existing_gift`
path supports the *reverse*: when the reviewer picks a donor that differs from the
gift's current donor and confirms, the body carries `switchGiftDonor: true` and the
gift's donor is **re-pointed** to the chosen one (the gate, the gift UPDATE, and
the staged-row donor adoption all use `effectiveGiftDonor`). Guards on this path:
`hasExactlyOneDonor` on the body donor → 400; and if the gift is a payment on a
pledge/opp owned by a *different* donor, the switch is **blocked** with 409
`gift_pledge_donor_conflict` (fix the pledge first). So: silent Match → adopt the
gift's donor; explicit confirmed switch → re-point it. Don't collapse the two.
