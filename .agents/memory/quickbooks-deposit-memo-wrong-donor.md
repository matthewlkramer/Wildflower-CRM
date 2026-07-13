---
name: QB deposit memo / stale charge auto-match can name the wrong donor
description: Reconciler card donor labels prefer the charge's donor FK (which a stale auto-match can set wrong), falling back to the QB deposit memo (hand-typed, also unreliable); the payout's charges (payer_name/description) are authoritative.
---

The reconciliation card's donor label prefers `stripeChargeDonorName` — derived from the
CHARGE's donor FK COALESCE in cards.ts — over the QB memo `payer_name`. Both sources can be
wrong: the charge's donor FK can be mis-set by a stale auto-match, and the hand-typed QB memo
can name a different donor entirely. A real prod case had BOTH wrong the same way: a deposit
memo "Donation from Donor A via Stripe" AND a charge FK pointing at Donor A, while the charge's
own `payer_name`/description proved it was Donor B's same-amount donation days after Donor A's
identical-amount gift (already fully booked with QB+Stripe evidence).

**Why:** Stripe deposits arrive as lump transfers; QB memos are hand-typed and same-amount
adjacent donations get mislabeled, and the charge auto-matcher can adopt that wrong name.
Accepting the suggested "Create new gift" double-books the named donor and loses the real
donor's money. The per-charge link-gift route ADOPTS THE GIFT'S DONOR, so linking the charge
to the right donor's existing gift self-heals a wrong charge FK; a guarded one-row SQL repoint
fixes the label pre-link.

**How to apply:** Before trusting a card's donor label, resolve the deposit → settlement
link → payout → charges chain; the charge payer(s) are the truth. If the named donor's
same-amount gift already carries counted QB+Stripe evidence, the deposit belongs to someone
else. Also: when verifying "did the user's action land?", compare row `match_confirmed_at`
timestamps against the screenshot filename's ms epoch (`image_<ms>.png`) — screenshots
often predate the action.
