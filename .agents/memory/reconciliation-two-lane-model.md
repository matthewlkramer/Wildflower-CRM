---
name: Two-lane reconciliation model
description: Every unit of money tracks two independent derived lanes (funding + crmRecord); the rules for deriving and surfacing them.
---

# Two-lane reconciliation model

Every unit of money has TWO independent reconciliation lanes, each progressing
`unlinked → proposed → confirmed` (plus an `exempt` terminal where no connection
is expected):

- **funding** — accounting/evidence side (QuickBooks / Stripe). "Is this money tied
  to real booked evidence?"
- **crmRecord** — donor-record side. "Is this money attached to a confirmed CRM
  donor record?" `null` where no single donor applies (e.g. a Stripe payout, which
  is a batch with no single donor).

**Rule:** the two lanes are DERIVED, never stored — there is NO column and no source
of truth beyond existing fields. Derive with pure functions (mirroring the
`deriveGiftQbTie` / `deriveOppFields` pattern), reading only existing fields.

**Why:** a single "blended" reconciliation badge conflated two genuinely independent
questions (is the money booked? is the donor confirmed?). A row can have money
confirmed but donor open (auto-applied gift link) or donor confirmed but money open;
collapsing them hid real review states.

**How to apply:**
- A CRM gift IS the confirmed CRM record (Donor XOR) → its crmRecord lane is always
  `confirmed`; its funding lane mirrors the persisted QuickBooks-tie signal.
- For unmatched evidence (staged payment / Stripe charge): a gift LINK alone does NOT
  confirm the donor lane — that requires a human-stamped match (matchConfirmedAt) or
  a real donor FK. Conversely an auto-applied gift link confirms funding while the
  donor lane stays proposed.
- If a new evidence/gift state appears, extend the pure deriver — never add a stored
  column or write a lane status.
- EVERY user-facing unreconciled-evidence endpoint must emit the lanes (the
  QuickBooks staged-payments queue was missed on the first pass and flagged in
  review). Keep the gift, gift-audit, reconciliation-card, Stripe staged-charge,
  Stripe payout, AND QuickBooks staged-payments surfaces in lockstep.
- The two dedicated review pages (staged-payments queue UI, Stripe reconciliation)
  already show per-track (not blended) status, so the blended-badge replacement only
  touched the gift-detail and reconciliation-card surfaces.
