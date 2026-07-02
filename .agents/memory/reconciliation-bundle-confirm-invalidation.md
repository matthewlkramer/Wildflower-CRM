---
name: Bundle confirm must invalidate the whole workbench, not just the anchor list
description: Confirming a settlement bundle reconciles rows shown by the workbench's OTHER queues; refresh them all or the money lingers.
---

# Settlement-bundle confirm cache invalidation

The reconciliation workbench renders several independent React Query queries:
- the settlement-anchor list (`/api/reconciliation/bundle-anchors`),
- the Needs review / QBO-only / research / excluded / confirmed queues, all one
  `useListReconciliationCards` query (key prefix `/api/reconciliation/cards`),
- staged-payments lists (`/api/staged-payments`),
- gifts lists (`/api/gifts-and-payments`),
- the CRM-only "gifts missing QuickBooks" list + badge
  (`/api/reconciliation/gifts-missing-qb`).

**Rule:** a settlement-bundle confirm reconciles the SAME underlying rows those
other queues render (it flips staged/charge `status` to `reconciled` and
mints/matches gifts). So the confirm handler must invalidate ALL of those
families, not only the anchor list.

**Why:** confirming a bundle only invalidated the anchor list, so the
just-confirmed money kept showing in the top-level "Needs review" queue (a
separate `useListReconciliationCards` query) until a hard reload — the reported
bug. Each queue is its own query; invalidating one does not refresh the others.

**How to apply:** the workbench's own post-apply `invalidateAll` is the canonical
set to mirror (`/api/reconciliation/cards` via a `startsWith` predicate +
`/api/staged-payments` + `/api/gifts-and-payments`); a bundle confirm should
additionally invalidate `/api/reconciliation/gifts-missing-qb` because it is the
flow most likely to resolve a stray gift. Invalidation keys need the full `/api`
prefix to match the generated Orval query keys.

**Not a bug (by design):** a Stripe payout whose tie is `unmatched` (no QB
deposit yet), and research-only bundles, legitimately STAY in the anchor
needs_review list after confirm — the payout↔deposit tie is still open work.
