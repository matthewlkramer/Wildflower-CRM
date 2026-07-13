---
name: Confirmed staged-row relink (openForRelink)
description: Which match_confirmed staged rows may be re-targeted, and the guarded path that does it.
---

A `match_confirmed` QB staged row is NOT uniformly terminal on the approve/link path.
Shapes and their rules:

- **Confirmed DIRECT match** (matchedGiftId set, createdGiftId NULL, groupReconciledGiftId
  NULL) → `openForRelink`: the link path falls through to the normal consistency gate
  instead of hard-409ing. Re-targeting to a different gift composes
  `payment_already_applied` and requires explicit `moveOwnApplication` — never a silent
  re-point. Legacy rows confirmed before the ledger read-flip carry NO
  payment_applications row; the applied-gift check must fall back to the matchedGiftId
  pointer or those rows re-point silently. Same-gift re-link is an idempotent 200 no-op.
- **Minted (createdGiftId) or grouped rows** → still hard 409 (staged row owns its mint).
- **Settlement-only confirmed** (status derives ONLY from a confirmed settlement link /
  counted PA, no gift link) → still a 409 dead-end on BOTH mint and link deposit paths;
  the correct flow is the per-charge card (charge link-gift / create-gift).

**Why:** two prod dead-ends — a settlement-only confirmed deposit with a pending charge
in a multi-charge payout, and a confirmed direct-matched deposit whose single charge was
still pending — had no UI path forward.

**How to apply:** the relink UPDATE in the commit layer re-checks the exact
direct-match shape in SQL under the row lock (settlement-only/minted/group/split rows
match zero rows → conflict). When a moveOwnApplication re-point succeeds, also re-point
`settlement_links.conflict_gift_id` (scoped to this deposit + old gift) so the
conflict-keep invariant (kept gift == deposit's gift link) survives the move. Client:
a confirmed deposit card picking a DIFFERENT gift must fall back to the deposit
approve path (where the move dialog lives), not the per-charge link.

Deriving `match_confirmed` in tests: a gift link, OR a confirmed settlement link
(seed a payout + flip its settlement link lifecycle to 'confirmed'), OR a counted PA —
`matchStatus: "matched"` alone derives pending. Gate 409 error string is
`consistency_gate` with `details.issues[].code`.
