---
name: CRM-only reconciliation worklist (allocation rows)
description: The Reconciliation Workbench "CRM-only" tab is allocation-granular, but actions that reconcile/revert money are gift-level.
---

The "CRM-only" worklist (`/api/reconciliation/gifts-missing-qb`, rendered by
`reconciliation-stray-gifts.tsx`) lists ONE ROW PER `gift_allocation`, not per
gift. A gift with three allocations is three rows; a gift with no allocations is
one row. Stable React key / dedupe key is `rowKey = ${giftId}:${allocationId ?? 'none'}`.
Entity exclusion is allocation-level via `entities.expectsPayment = false`
(NULL entity or NULL expectsPayment ⇒ kept).

**Why it matters:** the row granularity is allocation, but the money operations
are NOT.
- **Payment linking is gift-level only.** There is no allocation↔payment link in
  the schema; reconciliation attaches a QuickBooks staged payment to the whole
  GIFT (`POST /staged-payments/:id/reconcile {giftId}`). So both the
  "Link allocation → payment" and "Link gift → payment" menu actions reconcile
  the same gift — they differ in copy only. Don't assume a per-allocation link
  exists; adding one is real schema work.
- **Revert is gift-level.** `POST /gifts-and-payments/:id/revert-to-opportunity
  {asPledge?}` archives the whole gift and mints one opportunity/pledge carrying
  all its allocations over to `pledge_allocations`. Guards: archived / already
  on a pledge / QB-linked all 409. `asPledge=true` sets `writtenPledge`.
- **Edit row is the only truly per-allocation write** (`PATCH /gift-allocations/:id`),
  enabled only when `allocationId` is non-null.

**How to apply:** when extending CRM-only actions, decide whether the action is
allocation-scoped (edit) or gift-scoped (link/revert/flag) — most are gift-scoped
because that's where the money records live. The nav badge count comes from the
endpoint's `pagination.total` (allocation count, not gift count).
