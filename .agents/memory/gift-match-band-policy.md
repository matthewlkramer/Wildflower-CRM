---
name: Gift↔payment match band policy (single source of truth)
description: All gift↔payment amount/window matching flows through lib/giftMatch.ts; three band variants with distinct roles, and the ready ⊆ approve-gate invariant.
---

# One source of truth

Every gift↔payment amount/date match predicate (QB staged-payment anchor, Stripe
charge anchor, multi-match, ingest matcher, gift-candidate search) must build
its amount bounds and window from `artifacts/api-server/src/lib/giftMatch.ts`, not
hand-rolled `g.amount BETWEEN ...` fragments. Windows: `GIFT_MATCH_WINDOW_DAYS`
(reconcile/proposal reads) vs `INGEST_GIFT_WINDOW_DAYS` (the insert-time matcher).

# Three band variants, distinct roles — do not collapse them

- **strict** (`giftMatchAmountBounds(..., strict=true)`) — near-equal to full amount.
  This is the "ready"/gate band. The one-click *ready* set must equal the approve
  gate's pass set (`amountWithinFeeBand`), so ready is counted with strict.
- **widened / proposal** (`strict=false`) — may surface an under-gross gift to
  *propose*. A widened-only match is never one-click ready; it needs the gate's
  amount-mismatch override at approve.
- **known-net** (`giftMatchAmountBoundsKnownNet`) — for Stripe charges where NET is
  known: window is `[LEAST(net,gross), GREATEST(net,gross)]` ± epsilon. `LEAST`/
  `GREATEST` ignore NULLs, so callers MUST also guard `net_amount IS NOT NULL`
  (and gross) or the band silently degrades.

**Invariant:** ready ⊆ approve-gate pass set. Never widen the ready/strict band to
match the proposal band, or one-click approve will 409 at the gate.

# Why

Stray matchers drifted apart (e.g. a Stripe charge with known net $99.26/gross
$104.42 proposed "create gift" instead of matching the donor's existing $104.00
same-date gift). Centralizing the bands fixed the divergence and keeps propose vs
ready vs gate consistent.

# How to apply

When adding any new place that matches money to a gift, import the giftMatch
helpers and pick the variant by role (propose → widened, ready/gate → strict,
Stripe-net-known → known-net). Add an integration test that executes the rendered
SQL (see `drizzle-sql-template-outer-paren.md` — these builders embed a donor
OR-group and are exactly the shape that hides a paren-imbalance from typecheck and
unit tests).
