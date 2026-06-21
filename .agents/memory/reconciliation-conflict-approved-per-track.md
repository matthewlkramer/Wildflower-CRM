---
name: Reconciliation conflict_approved = awaiting, not a discrepancy
description: Semantics of the Stripe payout conflict_approved state and why the reconciliation card shows status per-track (QB vs Stripe).
---

# `conflict_approved` is NOT a money discrepancy

On the QB-anchored reconciliation card, a Stripe payout's
`qb_reconciliation_status = 'conflict_approved'` does **not** mean the amounts
disagree. It means the **QuickBooks side was already approved into a gift**
(staged row `approved`/`reconciled` with a non-null gift id), so the system will
not auto-attach the Stripe evidence to an already-approved gift — it only needs a
**human to confirm tying the Stripe payout in**. Typical shape: one Stripe gross
charge ($X) with a processor fee, QB deposit (net) already approved into the gift
at gross; nothing is double-booked or mismatched.

**Why:** a reviewer read the single sweeping card status ("Needs review" / the
flat "Already approved." blocker) as a problem and could not tell which track was
outstanding (real case: Cantoni 11/19/25 — clean $50 gross / $2.75 fee / $47.25
net, QB already approved, Stripe payout just awaiting confirm).

**How to apply:**
- Surface reconciliation status **per track** (a QuickBooks track + a Stripe
  track), never as one combined badge. QB track derives from the staged-payment
  status; Stripe track derives from the payout's `qb_reconciliation_status`.
- Present `proposed` and `conflict_approved` as *awaiting* (not error) states;
  `conflict_approved`'s user label avoids the word "conflict" ("Awaiting
  confirmation") because that word read as a discrepancy to users.
- The actual human confirm for this case still happens via the Stripe-payout
  confirm path (confirmConflictPayout: `conflict_approved` → `confirmed_reconciled`).
