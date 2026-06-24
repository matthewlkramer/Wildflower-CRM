---
name: Reconciliation bundle queue
description: How the Stripe/Donorbox settlement-bundle queue in the workbench is scoped and why some axes show empty.
---

# Reconciliation workbench — settlement bundles

The "Stripe/Donorbox bundles" queue (`reconciliation-workbench.tsx` `BundlesQueue`)
is **payout-anchored**: each card is one Stripe payout reconciliation row
(`/stripe-payouts/reconciliation`, queue `all`), with the QB deposit lineage
strip, per-charge explode (create-gift per `donorResolved && !hasGift` charge),
refund propagation, and Donorbox enrichment all hanging off it.

## Axis filter mapping (deliberate, not a bug)
- `all`, `qs` (QB⇄Stripe), `ds` (Donorbox⇄Stripe) → show ALL bundles.
- `qg` (QB⇄Gift), `qd` (QB⇄Donorbox) → show EMPTY.
**Why:** a bundle's spine is the deposit→payout tie; Donorbox lives inside each
card's lineage, not as its own list. Pure QB⇄Gift / QB⇄Donorbox money has no
payout-bundle surface (handled by the needs-review queue / donorbox review).
Don't "fix" qg/qd to list bundles.

## confirm-ties endpoint (`POST /reconciliation/bundles/{stagedPaymentId}/confirm-ties`)
Additive + idempotent + enrich-only: only fills NULL `linkedQbStagedPaymentId`
(charges) / `linkedStripeChargeId`+`linkedQbStagedPaymentId` (donations), stamps
who/when, **mints no gifts**, writes nothing back to QB/Stripe/Donorbox.

## D4 drift vs the task spec
Confirm marks the QB deposit `reconciled` (NOT excluded/processor_payout) and
does NOT archive a coarse gift — follows existing code, task text was obsolete.
(See reconciliation-single-source-of-truth.md.)

## Deviation: applies directly
The bundle queue applies actions directly (like the QBO bucket), NOT via the
pending-tray staging flow.
