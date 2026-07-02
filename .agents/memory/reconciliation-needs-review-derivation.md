---
name: Settlement needs_review is derived from actionable work, not payout status alone
description: Why the bundle-workbench needs_review anchor filter must gate an unmatched Stripe payout on having an OPEN charge, not just on qb_reconciliation_status.
---

# Settlement needs_review = actionable work, not status

The bundle-workbench settlement queue (`bundleAnchors.ts` `stripeWhere`) must NOT
put a Stripe payout in `needs_review` on `qb_reconciliation_status` alone. A payout
needs review only when there is actionable work here:
- its QB-deposit tie is awaiting a human decision (`proposed` / `conflict_approved`), OR
- it is still `unmatched` AND has ≥1 charge whose status is NOT terminal
  (terminal = `reconciled` / `excluded` / `rejected`; `pending`/`approved` are open).

**Why:** `unmatched` is a reproposable *data-state* ("no QB deposit tie proposed"),
NOT a workflow state — the confirm/tie step only ever advances `proposed`/`conflict_approved`,
never `unmatched`. So a fully-settled payout (every charge already booked into a gift,
no candidate QB deposit to tie) lingered in `needs_review` forever, resurfacing money
the user had already confirmed (recurring Stripe donors are the classic trigger — one
single-charge payout per month, each stuck). This mirrors the codebase's
derive-don't-write philosophy (opportunity status, gift QB tie): derive "needs review"
from remaining work, don't write a terminal status onto the payout.

**Do NOT "fix" this by advancing the payout to a terminal `confirmed_*` status on
charge settlement.** `REPROPOSABLE` (stripeReconcile.ts) includes `unmatched`; the
proposer re-scores those payouts on every scheduled sync + human propose-all pass. A
terminal status would foreclose a later tie when the QB deposit lump finally syncs.

**How to apply:** dropped payouts are never hidden — they remain under the `all`
queue, re-enter `needs_review` as `proposed` when the propose-all tie pass runs, and
the standalone QB deposit (if it exists) surfaces via `qbWhere` and canonicalizes to
the payout on assemble. Negative-amount / zero-charge payouts (refunds/reversals)
also correctly drop out (no charges to reconcile). Frontend `BundleAnchorList` reads
this one endpoint (no separate count query), so the filter is the single source.
