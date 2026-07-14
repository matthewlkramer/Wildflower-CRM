---
name: Per-charge routing must cover every approve entry path
description: Re-admitted per-charge cards on confirmed deposits must route to the per-charge link from ALL approve entry points; the deposit-approve link path has no charge-anchored escape hatch by design.
---

**Rule:** any UI path that approves a per-charge reconciliation card must take the
per-charge link route (POST /stripe-staged-charges/:id/link-gift) when EITHER the
payout holds >1 charges OR the deposit is already confirmed
(`card.status === "match_confirmed"` — card.status is the DEPOSIT's derived status
even on a per-charge card). Entry paths: single-card confirm, gift search/re-target,
and bulk approve. A missed branch stages the card into the deposit-keyed tray, whose
Apply hits the deposit approve route and 409s forever — the tray masks it as
"Already resolved — refreshed", an invisible permanent loop.

**Why:** the deposit approve route's `link_existing_gift` path deliberately has NO
charge-anchored escape hatch (only the MINT path got one — minting had no alternate
route; linking does, via link-gift). Its 409 ("Book the remaining money from its
Stripe charge card instead") is an accurate guided backstop, and duplicating the
link-gift commit logic inside that large money route was rejected as drift risk
(architect-ratified 2026-07-14). So correctness lives entirely in frontend routing.

**How to apply:** when adding/altering any workbench approve entry point, mirror
tryLinkMultiChargeCard's predicate (`isMultiCharge || depositConfirmed`). In bulk
(no graph available), additionally skip-and-report a confirmed-deposit card whose
proposedGiftId and resolvedGiftId both exist and differ — that shape is a re-target
of booked money that must go through the single-card guarded confirm, or the same
physical money gets counted on two gifts (the double-book guard is anchor-kind-aware
and will NOT block it).

Related one-row prod repair precedent: a settlement link's stale `conflict_gift_id`
(reviewer "kept" a gift based on a wrong QB payer label) blocks the per-charge MINT
gate forever; clear it with a guarded idempotent migration whose EXISTS guard proves
the "already recorded as this gift" claim false (the gift's counted PA points at a
different charge).
