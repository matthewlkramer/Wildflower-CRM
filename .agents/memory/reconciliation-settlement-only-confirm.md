---
name: Settlement-only confirm vs gift-report queue
description: Why confirming just the payout↔deposit settlement needs an explicit "reconciled + unbooked charge" branch in the gift-report queue, or charges silently vanish.
---

The reconciliation workbench SETTLEMENT report confirms ONLY the payout↔deposit
settlement link (Plane 1) — one-click Approve on a "linked" card. That path calls
the existing tie primitive (`confirmPendingQbDepositInTx`), which marks the QB
deposit lump `status='reconciled'`. Per-charge crediting to gifts (Plane 2) is
left to the GIFT report exclusively.

**The trap:** the gift-report default queue (`reconciliationQueueWhere` in
`cards.ts`) historically treated `reconciled` as terminal (admits only `pending`
and `approved`-with-settlement-link). That was safe only because the OLD
bundle-confirm booked every charge atomically before stamping `reconciled`, so a
reconciled deposit ALWAYS had all charges booked. Decoupling the two planes broke
that invariant: a settlement-confirmed deposit can now be `reconciled` while its
Stripe charges are still uncredited — and those charge cards only exist as a
LATERAL expansion off the deposit row, so if the deposit fails the queue predicate
the unbooked charges become invisible and unbookable → silent under-credit.

**The rule:** the default gift-report queue must include a third branch —
`status='reconciled' AND EXISTS (settlement_links → stripe_staged_charges with
COALESCE(matched_gift_id, created_gift_id) IS NULL)` — so a settlement-confirmed
deposit stays in the live queue until every backing charge is booked, then drops
out on its own (the existing unresolved-charge LATERAL filter collapses it to just
the open charge cards).

**Why:** no double-CREDIT risk exists (a reconciled deposit can't be booked coarse),
but charges can be LOST. Any future change that stamps a deposit `reconciled`
without also booking its charges must keep this queue branch (and its `shouldExpand`
membership) intact, or money goes uncredited without any surface showing it.
