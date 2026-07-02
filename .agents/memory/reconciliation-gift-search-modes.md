---
name: Reconciliation gift search — 1:1 match vs split mode
description: Why the reconciliation gift-candidate search has two amount/date windows and must keep them distinct.
---

The reconciliation gift-candidate search (`searchReconciliationNode`/`fetchGiftCandidates`
in `reconciliationGraph.ts`, route `/reconciliation/search/:nodeType`) serves TWO
different UI flows off one endpoint, gated by a `split` query flag:

- **1:1 match** (default): the payment maps to ONE gift, so candidates must be
  near-equal to the FULL staged amount — window is `amount >= payment − 0.01`
  (lower fee-band floor) `.. <= payment*1.10 + 1`, ordered by proximity to the
  full amount, date-windowed by `±days`, confidence = amount closeness.
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

**How to apply:** keep the two windows distinct — never fold split candidates
into the near-equal window, and never apply the near-equal lower floor when
`split` is set. The Stripe-charge anchor and QB staged anchor both flow `p.split`
through `searchGifts`, so both anchors honor split mode.
