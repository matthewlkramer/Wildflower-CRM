---
name: Charge-tie pair dismissals
description: Rejecting a proposed charge↔QB tie persists a pair-level dismissal; propose pass skips it forever, manual tie overrides it.
---

Rejecting a proposed charge↔QB tie on a Missing-deposit card persists the pair
into `stripe_staged_charges.dismissed_qb_staged_payment_ids` (text[] append,
JS-dedup'd in the reject route).

**Rules:**
- The automatic propose pass (`runChargeTiePass` / `assignChargeQbTies`) must
  skip a dismissed pair — but only that exact pair; the same QB row stays a
  candidate for other charges, and other QB rows stay candidates for the
  dismissing charge.
- `assignManualChargeQbTies` ("Tie selected") intentionally IGNORES dismissals —
  an explicit human tie always overrides a prior reject. Don't "fix" this.
- There is no un-dismiss path yet (follow-up); a mis-click reject can only be
  recovered via manual tie.

**Why:** without persistence the nightly tie pass re-proposed every rejected
pair, making Reject useless; without the manual override a mis-click would be
unrecoverable.

**How to apply:** any new proposal source for charge↔QB ties must check the
dismissal list; any new dismissal writer must dedup and guard on
already-confirmed ties (409).
