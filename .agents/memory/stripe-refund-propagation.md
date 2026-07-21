---
name: Stripe refund/chargeback propagation
description: Implemented refund flow (propose-then-confirm; confirm mutates the gift) — RATIFIED DRIFT as of 2026-07-21; refunds are transaction facts; do not extend the gift-mutation behavior.
---

**STATUS: implemented behavior that is now RATIFIED DRIFT (2026-07-21).** The
ratified rule (`replit.md` invariant #7, `docs/workbench-business-rules.md`): a
processed refund removes/reduces live payment evidence only; it does not by
itself archive the gift, rewrite donor intent, or prove the gift unpaid — and
there is NO anticipatory refund state. Gift disposition after a refund is a
separate human decision. Do not extend the confirm-mutates-gift behavior below;
the repair direction is tracked in `docs/reconciliation-status.md`.

Implemented flow:

- The Stripe sync worker raises a proposal on the `stripe_staged_charges`
  evidence row (`refund_propagation_status`: `none|proposed|applied|dismissed`).
  Pure `classifyRefund` decides `full_refund|partial_refund|chargeback`; the
  `refunded` boolean forces a full refund even on a tiny amount, so the
  sub-cent-noise guard only fires when `refunded` is false.
- A human confirms/dismisses. Confirm (this is the ratified drift):
  full/chargeback → archive (soft-delete) the gift; partial → reduce its
  amount; then re-derive the linked pledge paid/status. The evidence row is
  RETAINED, flipped to `applied`. (The old "recompute QB tie" step is obsolete —
  the tie is live-derived now; there is no applier.)
- Forward-only + idempotent: existing rows default to `none` so no proposals
  are raised retroactively; a re-confirm returns 409 `not_proposed` (guard on
  status='proposed' in the applier UPDATE).

**How to apply while the drift stands:** every staged-row state transition must
guard the prior status in the UPDATE itself, not just a pre-read. Out of scope
by design: negative-adjustment accounting, GL/period handling,
auto-apply-without-confirm.
