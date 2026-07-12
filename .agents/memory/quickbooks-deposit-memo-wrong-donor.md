---
name: QB deposit memo can name the wrong donor
description: Reconciler card payer labels come from the QB deposit memo, which can name a different donor than the money actually belongs to; the charges inside the settling payout are authoritative.
---

The reconciliation card's payer label / "Create new gift — <name>" suggestion is derived
from the QuickBooks deposit memo (payer_name / line_description). That memo can be flat-out
wrong: a real prod case had a deposit labeled "Donation from Donor A via Stripe" whose
settling payout contained exactly one charge — Donor B's, for the same amount, one day
after Donor A's identical-amount donation (which was already fully booked with both QB and
Stripe evidence on Donor A's gift).

**Why:** Stripe deposits arrive as lump transfers; QB users type the memo by hand and
same-amount adjacent donations get mislabeled. Accepting the suggested "Create new gift"
double-books the named donor and loses the real donor's money.

**How to apply:** Before trusting a card's donor label, resolve the deposit → settlement
link → payout → charges chain; the charge payer(s) are the truth. If the named donor's
same-amount gift already carries counted QB+Stripe evidence, the deposit belongs to someone
else. Also: when verifying "did the user's action land?", compare row `match_confirmed_at`
timestamps against the screenshot filename's ms epoch (`image_<ms>.png`) — screenshots
often predate the action.
