---
name: settlement_links Plane-1 dual-write & parity gate
description: Non-obvious constraints when mirroring stripe_payouts recon state into settlement_links and gating the read-flip.
---

Phase-4 of the reconciliation redesign gives batch↔batch (Stripe payout ↔ QB
deposit) its own `settlement_links` table, additively dual-written from the legacy
`stripe_payouts.qb_reconciliation_status` + pointer columns via a single pure
mapping (`deriveSettlementLinkFields`) that the runtime dual-write, the 0089
backfill, and the parity gate ALL reuse. Two durable, non-obvious traps:

## confirmed_at drifts for non-human links — never compare it exactly there

`deriveSettlementLinkFields` sets `confirmedAt = COALESCE(qb_reconciliation_confirmed_at, updated_at)`.
The Stripe sync worker's payout upsert bumps `stripe_payouts.updated_at` on EVERY
re-pull **without** re-syncing the settlement link. So any link whose confirmedAt
came from the `updated_at` fallback (every `system_confirmed` link, plus any legacy
`human` row that has `confirmed_by` set but `confirmed_at` NULL) legitimately drifts.

**Rule:** the parity gate compares `confirmed_at` EXACTLY only when the derive read
the stable column — i.e. `provenance === 'human' AND qb_reconciliation_confirmed_at
IS NOT NULL`. Everywhere else it checks presence only (non-null for confirmed, null
for proposed). All load-bearing fields (lifecycle, provenance, deposit,
confirmed_by) are still compared strictly, so this does not open a false-PASS window.
`note` is also excluded (it holds the backfill's `legacy <status>` marker, not part
of the mirror).

**Why:** without the `qb_reconciliation_confirmed_at IS NOT NULL` guard the gate
false-FAILs on prod after any sync re-pull.

## deposit FK is ON DELETE SET NULL but a CHECK requires it — deletes error

`settlement_links.deposit_staged_payment_id` is `ON DELETE SET NULL`, yet
`settlement_links_deposit_required_chk` requires a non-`exempt` link to carry a
deposit. Postgres evaluates CHECKs during a referential SET NULL, so hard-deleting a
`staged_payments` row referenced by a `proposed`/`confirmed` link raises a CHECK
violation instead of nulling the pointer. Latent today (archive-not-delete; no
`delete(staged_payments)` path), but any future staged-payment wipe/delete tooling
must first clear or re-`exempt` the referencing links.

**How to apply:** dual-write coverage must hit ALL payout-recon write sites (grep
`update(stripePayouts)` + every writer of qbReconciliationStatus / the three pointer
cols — currently reconciliationCommit ×2, stripeConfirm ×7, stripeReconcile ×2); the
read-flip is gated on `parity:settlement-links` returning zero exceptions on **prod**
(dev parity ≠ prod), per the 0089 RUNBOOK.

## The parity gate is mirror↔deriver only — a read-flip can still shift derived semantics

`parity:settlement-links` proves `settlement_links` faithfully mirrors the legacy
status/pointer columns. It does **not** prove the flipped READS produce the same
derived output as the pre-flip reads. Those are different comparisons: the gate never
sees `derivePayoutLanes` / `deriveSettlementLinkFields` lane output.

Concrete case: the 0089 backfill maps ALL `confirmed_*` (via `LIKE 'confirmed_%'`),
**including `confirmed_excluded`**, to a `confirmed` link — `confirmed_excluded` IS a
confirmed settlement (the exclusion is a Plane-2 fact on
`staged_payments.exclusion_reason`, not a payout-settlement state; `exempt` is
reserved for links with no expected QB deposit). So after the read-flip a
`confirmed_excluded` payout's funding lane reads `confirmed`, where the pre-flip
legacy-status lane read `exempt`. The parity gate is blind to this; dev holds zero
`confirmed_excluded` rows.

**How to apply:** when flipping reads onto a mirror, don't trust the parity gate as
proof of read-equivalence. Diff the derived output on any status/edge the mirror maps
differently than the old read path, and read-only-check prod's population of those
edge statuses (here `confirmed_excluded`) before deprecating the legacy source.
