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
- Post-close under-payment → cannot edit the closed gift → **write-off**. Write-off =
  a NEW transaction in the current open FY that books the shortfall as negative
  revenue and zeroes the receivable (example: $100 pledge booked FY25; $80 paid FY26
  reduces receivable; FY27 decide uncollectible → book −$20 revenue, receivable→0).
  So write-off is a PLEDGE-receivable concept, not a gift edit — it does NOT
  retroactively change closed-year booked revenue. The underpaid gift itself is set
  to the cash that actually landed.
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
