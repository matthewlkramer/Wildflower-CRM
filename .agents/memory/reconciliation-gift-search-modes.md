---
name: Reconciliation gift search — 1:1 match vs split mode
description: Why the reconciliation gift-candidate search has two amount/date windows and must keep them distinct.
---

The reconciliation gift-candidate search (`searchReconciliationNode`/`fetchGiftCandidates`
in `reconciliationGraph.ts`, route `/reconciliation/search/:nodeType`) serves TWO
different UI flows off one endpoint, gated by a `split` query flag:

- **1:1 match** (default): the payment maps to ONE gift, so candidates are
  near-equal to the FULL anchor amount, ordered by proximity, date-windowed,
  confidence = amount closeness. The amount/date window is DONOR-SCOPE-DEPENDENT:
  - **donor resolved** (a `donorFilter` is set — the normal case; BundleRowEditor
    passes `donorId`, graph auto-suggest sets `giftDonorFilter`): widen to a fee
    band on BOTH sides (`amount >= anchor*0.90 - 1 .. <= anchor*1.10 + 1`) and a
    date floor of `DONOR_SCOPED_GIFT_WINDOW_DAYS` (90, via `Math.max(days, 90)`).
    Scoping to one donor makes cross-donor false positives impossible, so the
    window can be generous — this catches gifts booked UNDER the Stripe GROSS
    (fee-cover/rounding, e.g. a $104.00 gift behind a $104.42 charge) or net of
    fees, and gifts booked weeks off the settlement date.
  - **no donor**: keep the tight near-equal floor (`amount >= anchor - 0.01`) and
    the caller's `days`, to avoid a cross-donor flood.
- **split** (`split=true`, "Split payment across gifts" dialog): candidates are
  FRACTIONS of the payment, so the lower floor is wrong — it makes the search
  empty by construction (every fraction is below `payment − 0.01`). Split mode
  drops the lower bound (`amount > 0 .. <= payment*1.10 + 1`), RELAXES the date
  window (a lump payment covers gifts booked across many months), orders by date
  proximity/recency (amount proximity is meaningless), and suppresses the
  amount-confidence score (it would be misleadingly low vs the full payment).

**Why:** the split dialog originally reused the 1:1 search anchored to the full
amount, so splitting a large payment (e.g. $478,660.14) across smaller gifts
returned nothing.

**Why (donor-scoped widening):** the charge anchor is the Stripe GROSS, but real
gifts are often booked slightly under gross (fee-cover/rounding) or weeks off the
settlement date, so the old tight 1:1 window missed them. Calibrated on prod (262
pending charges with a matched donor, no gift link): the old window found 210;
fee-band + 90d finds ~233. 90d is the ceiling — the next real charge↔gift date
gaps jump to 366d+, so wider only pulls wrong-year gifts.

**How to apply:** keep the two windows distinct — never fold split candidates
into the near-equal window, and never apply the near-equal lower floor when
`split` is set. Treat donor-scope as the SAFETY BOUNDARY for the 1:1 widening:
only widen amount/date when a `donorFilter` is present; never widen an un-scoped
search. The Stripe-charge anchor and QB staged anchor both flow `p.split` through
`searchGifts`, so both anchors honor split mode; both also get the donor-scoped
widening (gated on `donorFilter`, not anchor type).
