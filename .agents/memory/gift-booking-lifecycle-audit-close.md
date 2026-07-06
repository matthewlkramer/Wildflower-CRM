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
  gift's governing FY = FY of `date_received`. A pledge's governing FY = the year it
  was MADE — the FY containing its `actual_completion_date` (won/close date) — NOT its
  allocation grant years. A multi-year pledge whose first allocation is a year or two
  out still freezes whole-record by its made-year. (Confirmed with the finance lead.)
  So changing an allocation's grant_year never moves the pledge's governing FY.
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

Amount-mismatch signal — REUSE the shipped `quickbooks_tie_status`; do NOT add a new
persisted status. One-count is already enforced by
`giftQbTie.ts` via PER-SOURCE PRECEDENCE (QB sum wins, else Stripe, else Donorbox — not
a cross-source SUM) over counted `payment_applications` rows, so `amount_mismatch`
already detects gift-vs-evidence mismatches without double-counting. The
`exempt|reconciled|partial|unreconciled` rename (tracked in docs/reconciliation-design.md)
is a LATER reconciliation phase, OUT OF SCOPE here — `quickbooks_tie_status` is still
actively read/written and NOT drop-ready. `giftAmountResolution.ts` is the single
swap-point if it is ever renamed.
Compute over- vs under-payment DIRECTION on the fly in the resolution/worklist layer
(precedence linkAmount vs gift.amount), NOT as a new persisted enum value.

**Why:** ratified by the product owner (finance lead) as the real audit/accounting
behavior; getting freeze/write-off wrong would misstate audited books.
**How to apply:** gate every gift/pledge/allocation mutation (PATCH, allocation CRUD,
bulk, merge, QB revert hard-delete, reconciliation stamp, archive) with a shared
assertMutable() keyed to the governing FY's audit-close date; drive the amount-
mismatch worklist + resolution actions off `quickbooks_tie_status` + the DERIVED
lifecycle. One-count is already shipped (giftQbTie per-source precedence), so no
all-source-SUM flip is needed.

Implementation constraints (must stay true across the freeze guard + resolution routes):
- **assertMutable must guard BOTH sides of a mutation.** Block mutating a record
  whose governing FY is closed, AND block edits that MOVE a record's recognition date
  into a closed FY. Recognition date = `date_received` (gift) / `actual_completion_date`
  (pledge); guard the resulting (post-update/merged) governing FY, not just the current
  one. A pledge's governing FY tracks its made-year, NOT its allocation grant years —
  so changing an allocation's grant_year does NOT move the governing FY (the earlier
  "grant_year drag" worry is moot). But allocation CRUD still mutates the pledge, so
  gate it by the PARENT pledge's governing FY.
- **Null-governing-FY records are always mutable (state it explicitly).** A gift with
  no `date_received` and a pledge with no `actual_completion_date` (or a date outside
  every FY window) have no governing FY, so freeze never applies. Keep this as "always
  mutable" rather than accidentally unfreezable.
- **The pre-close checklist must exclude resolution records on BOTH sides, and in BOTH
  directions.** Because a correction is a *linked new record* (the original's numbers
  never change), the underpaid/mismatch queries keep flagging FOREVER unless every
  resolution artifact is excluded. Four exclusions, easy to half-implement:
  - Underpaid pledges: exclude the original once it HAS a linked write-off
    (`NOT EXISTS (write_off_of_pledge_id = o.id)`), AND exclude the write-off pledge
    itself (`is_write_off = false`) — it is a settled negative, not an open ask.
  - Overpaid gifts: exclude the original once it HAS an active surplus child
    (`overpay_of_gift_id` present), AND exclude the surplus child gift itself
    (`overpay_of_gift_id IS NULL` in the unresolved predicate). The child has NO
    counted evidence so it defaults to `quickbooks_tie_status='missing'` and has NO
    resolution path of its own (its surplus is ≤0 → the resolve route 409s), so
    without this it flags forever in the FY it was booked into.

Build decisions (freeze guard + write-off/overpay resolution):
- **Booking lifecycle = DERIVED, persist nothing.** `booked_and_audit_closed` depends on
  fiscalYears.auditClosedAt, which flips on close/REOPEN; a stored column would need mass
  recompute + a prod backfill on every close/reopen for zero benefit. Derive from
  governingFY.auditClosedAt + counted-ledger presence, mirroring deriveGiftQbTie.
- **Freeze-guard coverage is enforced by a STATIC INVENTORY TEST, built FIRST** (mirror
  the merge-config FK-inventory test): scan src for `.update`/`.delete` of
  gifts_and_payments / opportunities_and_pledges + allocation insert/update/delete and
  FAIL unless every file is in a hand-maintained GUARDED-or-EXEMPT list, so a new mutation
  surface can't silently bypass freeze.
- **EXEMPT from freeze (must stay writable on frozen records):** derived-column appliers
  (giftQbTie's quickbooks_tie_status write, applyDerivedOppFields / pledge-stage status
  writes) and grant-letter / conditions edits — freeze covers audited ledger FACTS, not
  derived flags or next-year artifacts.
- **Write-off schema (additive SQL, never drizzle push):** opportunities_and_pledges
  gains `write_off_of_pledge_id` FK (→ original pledge) + `is_write_off` flag. The
  offsetting pledge copies the original's donor (Donor XOR) with negative allocation(s)
  (grant_year = current open FY, mirroring entity/restriction/usage). EXCLUDE is_write_off
  pledges from open-pipeline ask, win-probability, and goal analytics, and from the
  underpaid-pledge checklist via NOT EXISTS(linked write-off). Overpay = a NEW gift in the
  current open FY, linked back.
