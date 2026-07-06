---
name: Gift booking lifecycle & audit-close freeze
description: Accounting model for freezing gifts/pledges after a fiscal year's audit closes, plus write-off (pledge negative-revenue) and overpay→new-gift rules, and the derived reconciliation status that replaces quickbooks_tie_status.
---

Wildflower FY runs Jul 1–Jun 30. After 6/30 the finance team preps the prior year,
then the external audit reviews, then the **audit closes** (an admin-set date per
fiscal year). Audit close — NOT FY end — is the gating event.

**Rule:** once a fiscal year's audit is closed, the ledger facts that were audited
are frozen and cannot change.

Freeze scope & granularity:
- A gift/pledge and ALL its allocations freeze together (whole-record), governed by
  ONE fiscal year. Gifts can't be planned for future receipt (that's a pledge), so a
  gift's governing FY = FY of `date_received`. A pledge's governing FY = its
  recognized (booked) year.
- Frozen at close: amount, date_received, donor, off-books flags; per-allocation
  sub_amount, entity attribution, fiscal year, restriction axes, intended usage —
  anything that was a transaction in the audited ledger.
- Restriction & usage are "mostly frozen": a cosmetic change within the same revenue
  account may be OK, but any change that MOVES it to a different restriction/usage
  account must be a NEW gift (it has to appear as a transaction in the current year),
  same pattern as overpay.
- NOT frozen: you can still upload a new grant letter and change conditions — those
  show up in the NEXT audit.

Discrepancy handling depends on lifecycle:
- Pre-close: a genuine mismatch is just CORRECTED (money is authoritative); no
  acknowledge state.
- Post-close under-payment → cannot touch the closed pledge AT ALL (its allocations
  ARE the audited transactions — you can't even add a negative allocation to it) →
  **write-off = a brand-new offsetting PLEDGE** created in the current OPEN fiscal
  year, LINKED back to the original pledge, with negative allocation(s) summing to
  the uncollected remainder (grant_year = current open FY, mirroring the original's
  entity/restriction/usage buckets), flagged as a write-off. The two pledges net to
  zero across years; the original pledge is NEVER mutated. The original's unpaid
  remainder reads as RESOLVED because it has a linked write-off pledge — not because
  its own numbers changed. CRM is NOT the general ledger (QuickBooks is) — no
  double-entry. Mirrors the accounting "−$20 in FY27" (example: $100 pledge booked
  FY25; $80 paid FY26; FY27 uncollectible → new −$20 write-off pledge in FY27 linked
  to the FY25 pledge). The write-off pledge must stay OUT of open-pipeline ask (it's
  settled, not an open ask) yet count as a current-FY negative. The underpaid gift
  itself is set to the cash that actually landed. (pledge_allocations.sub_amount has
  NO positivity CHECK, so negative lines store fine; remainder clamps at 0.)
- General principle: a CLOSED record is immutable; every correction, write-off, or
  overpayment becomes a NEW linked record in the current open FY (write-off = new
  offsetting pledge; overpay = new gift), never an in-place edit of the audited row.
- Post-close over-payment → cannot edit the closed gift → **book a NEW gift** for the
  surplus, recognized in the current open FY.

Booking lifecycle stamp (DERIVED, not hand-set): `unbooked` (no counted cash) →
`booked` (cash recorded in QB) → `booked_and_audit_closed` (booked AND governing FY
audit-closed).

New derived gift reconciliation status (replaces `quickbooks_tie_status`
exempt|tied|amount_mismatch|missing): `exempt | unreconciled | partial | reconciled |
overpaid`, computed from the ALL-SOURCE counted ledger SUM vs gift.amount (fee-band
tolerant). Requires §4.3 one-count enforced first or QB-deposit + Stripe-charge rows
double-count.

**Why:** ratified by the product owner (finance lead) as the real audit/accounting
behavior; getting freeze/write-off wrong would misstate audited books.
**How to apply:** gate every gift/pledge/allocation mutation (PATCH, allocation CRUD,
bulk, merge, QB revert hard-delete, reconciliation stamp, archive) with a shared
assertMutable() keyed to the governing FY's audit-close date; drive the amount-
mismatch worklist + resolution actions off the derived status + lifecycle. Do §4.3
one-count before flipping any consumer to the all-source SUM.

Implementation constraints carried forward (from P1 review — honor in P4/P5):
- **assertMutable must guard BOTH sides of a mutation.** Block mutating a record
  whose governing FY is closed, AND block *moving* a record into a closed FY — e.g.
  editing/adding a pledge_allocation with an earlier `grant_year` can silently drag a
  pledge's governing FY (earliest grant-year allocation) back into an already-closed
  year (retroactive freeze), and moving an allocation INTO a closed FY must also be
  refused. Guard the resulting governing FY, not just the current one.
- **Null-governing-FY records are always mutable (state it explicitly).** A gift with
  no `date_received` (or a date outside every FY window) and a pledge whose allocations
  all have null `grant_year` have no governing FY, so freeze never applies. Decide/keep
  this as "always mutable" rather than accidentally unfreezable.
- **Underpaid-pledge detection must exclude already-resolved pledges.** The pre-close
  checklist / worklist flags underpaid written pledges via `SUM(allocations) > paid`.
  A P5 write-off resolves via a *linked* new offsetting pledge (the original's numbers
  never change), so this query will keep flagging the original FOREVER unless it also
  excludes pledges that already have a linked write-off. Add that exclusion in P5.
