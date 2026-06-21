---
name: Stripe refund/chargeback propagation
description: How Stripe refunds/disputes flow to CRM gifts (INV-13) — propose-then-confirm, forward-only.
---

Stripe refunds/chargebacks reach CRM gifts via a **propose-then-confirm** flow, never auto-apply.

- The Stripe sync worker raises a proposal on the `stripe_staged_charges` evidence row
  (`refund_propagation_status` enum: `none | proposed | applied | dismissed`). Pure
  `classifyRefund` decides the kind (`full_refund | partial_refund | chargeback`); the
  `refunded` boolean forces a full refund even on a tiny amount, so the sub-cent-noise
  guard only fires when `refunded` is false.
- A human confirms/dismisses. Confirm: full/chargeback → archive (soft-delete) the gift;
  partial → reduce its amount; then re-derive the linked pledge paid/status AND recompute
  the gift's QB tie (`applyGiftQbTieMany`). Evidence row is RETAINED, flipped to `applied`.

**Why forward-only + idempotent:** existing rows default to `none` so no proposals are
raised retroactively; a re-confirm must return 409 `not_proposed` (guard on
status='proposed' in the applier) so a re-sync never double-applies.

**How to apply:** any new evidence→gift mutation must go through the same applier (re-derive
pledge + recompute QB tie in the same txn), and every staged-row state transition must guard
the prior status in the UPDATE, not just a pre-read. Out of scope by design: negative-adjustment
accounting, GL/period, auto-apply-without-confirm.
