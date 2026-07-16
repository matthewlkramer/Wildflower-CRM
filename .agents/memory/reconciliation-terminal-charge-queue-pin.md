---
name: Terminal charges must count as settled in queue predicates
description: excluded/rejected Stripe charges have no gift link by design; any "all charges tied" predicate treating no-gift-link as open work pins the deposit card forever.
---

**Rule:** In every reconciliation predicate that asks "does this deposit still have unbooked charge work?", a charge whose derived status is `excluded` must count as settled — never as open work. "No gift link" alone is NOT "open": terminal charges never get a gift link by design (a failed payment attempt auto-lands `exclusion_reason='failed_charge'`; a human dismissal sets an exclusion reason too). Both states yield the derived status `excluded`.

**Why:** The cards live-queue lateral expansion kept any charge with a NULL resolved-gift id, so a deposit whose remaining unresolved charge was an excluded failed attempt stayed in the live queue forever — anchored on the dead charge, proposing "Create new gift" for money already fully booked (real prod case: a Stripe-source switch reconciled the real charge and auto-excluded the failed incumbent; the card persisted). The reconciled-deposit re-admit branch had the identical hole.

**How to apply:**
- The terminal predicate is `exclusion_reason IS NOT NULL` (the sole exclusion signal, as per derivedStatus.ts). Keep it consistent with the graph endpoint and bundle anchors. Note: the pre-deprecation term `rejected` mapped to an exclusion reason on the existing rows — the current vocabulary has no `rejected` state; `excluded` is the only terminal status.
- Fix BOTH the per-charge lateral filter and any re-admit EXISTS that scans charges for "unbooked" ones; the count query shares the conds so it follows automatically.
- A deposit whose charges are ALL terminal yields zero lateral rows → LEFT JOIN NULL-extension keeps it once as a plain deposit card (correct: the deposit itself may still be pending work).
