---
name: Conflict-approved "keep" double-book gate
description: When a conflict_approved payout's QB gift may be "kept", you must know exactly which gift — enforce at both the pure derive layer and the tx write boundary, or a per-charge mint double-books.
---

# Conflict-approved "keep" double-book gate

A `conflict_approved` Stripe payout means its tied QuickBooks deposit was already
booked into a gift. Confirming it as a **keep** preserves that deposit's gift as
the single source of truth and skips per-charge minting. A keep is only safe if
we can name EXACTLY which gift is kept; otherwise a later per-charge mint
double-books the same money.

**Rule:** A keep is permitted only when the kept gift is *known* and still
*matches the deposit's current gift link* (`createdGiftId ?? matchedGiftId ??
groupReconciledGiftId`, i.e. `candidateGiftId`).

**Why:** the conflict is recorded at propose time as
`qbConflictGiftId = candidateGiftId(deposit)` under an `exists(gift)` guard, so a
well-formed conflict *always* satisfies the equality. A null value is a
legacy/malformed row; a mismatch is post-propose drift. In both cases we can't
prove a per-charge gift wouldn't double-book, so block and force human review —
never silently keep.

**How to apply (BOTH paths, independently):**
- Pure derive layer: the bundle-workbench confirm re-derives a proposal and
  rejects on blocker warnings. A tie-level blocker must fire whenever a
  `conflict_approved` tie has no recorded kept gift — emit it independent of any
  client-supplied tie action override, so `summary.ready` stays honest.
- Write boundary: the tx-core that flips the payout to `confirmed_reconciled`
  must itself require the kept gift non-null AND equal to the locked deposit's
  current gift link. The legacy standalone confirm-keep route does NOT re-derive,
  so the pure-layer blocker alone does not cover it.

Any new path that confirms/keeps a conflict, or any change to how the kept gift
is recorded, must preserve "kept gift is known & matches the deposit" at BOTH
layers.
