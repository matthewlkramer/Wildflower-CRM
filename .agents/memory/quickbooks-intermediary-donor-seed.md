---
name: QuickBooks reconciler intermediary donor seed
description: Seed gift search with the real donor when the payer is a Stripe/Donorbox/DAF intermediary
---

On the staged-payments reconciler, selecting a left-column payment seeds the
right-side gift search with a donor name. When the payer / auto-matched donor is
a pass-through **payment intermediary** (Stripe, Donorbox, PayPal, Benevity, a
DAF / "donor advised fund", "charitable giving fund", etc.), the real donor is
NOT the payer — it's named in the memo / line description, usually in the same
sentence as the processor (e.g. "<processor> donation - <Donor Name>",
"...Donor Advised Fund Gift from <Donor Name>, for <project>").

**Why:** auto-match keys off the payer, so intermediary-routed gifts seed the
search with the processor / the DAF and surface no useful gifts; the fundraiser
had to retype the donor every time.

**How to apply:** the seed helper digs the donor out of `lineDescription` /
`rawReference` ONLY when the obvious name looks like an intermediary (keyword
list) or is empty. Extraction is intentionally conservative — it only trusts a
capitalized run after "from " or after a trailing " - ", and returns null
(falling back to the payer name) on ambiguous text rather than grabbing an
honoree ("in honor of X") or a generic phrase ("from various donors"). The seed
is an editable search box, so an imperfect guess is always recoverable; do not
make the regex greedier at the cost of false positives. Keep this heuristic for
the SEARCH seed only — never feed it into donor display or persisted donor fields
(those must stay factual: the matched/saved donor).
