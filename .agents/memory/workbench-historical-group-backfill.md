---
name: Reconciliation workbench historical-group backfill
description: Why legacy group-reconciled staged payments leak as orphan cards, and why a source_group_id backfill fixes it cleanly.
---

# Historical grouping must be copied into source_group_id

The reconciliation **workbench** groups staged-payment cards purely by
`staged_payments.source_group_id` (`groupRepresentativeWhere` collapses each
group to one card; `sourceGroupAggExpr` sums the total; approve uses the group
total so the fee-band gate passes).

The **legacy** `/staged-payments/group-reconcile` flow never set
`source_group_id`. It instead stamped `group_reconciled_gift_id` on EVERY member
and `matched_gift_id` on exactly one representative. So historical groups are
invisible to the workbench.

## The leak

The default/"all" queue excludes an `approved` row only when it has
`matched_gift_id` **or** `created_gift_id` (and no Stripe). It does NOT check
`group_reconciled_gift_id`. So every non-representative group member (which has
only `group_reconciled_gift_id`) **leaks into the queue as a standalone card**.
Trying to approve one compares ONE member's amount to the FULL gift → a false
"amount mismatch" the user can't clear. This was the root of the workbench
feedback about a $65k card that won't approve against an $80k gift, and the
"already-matched rows showing in the CRM-only queue" complaints.

## Why a data-only backfill is the complete fix

Backfill `source_group_id = 'histgrp_' || group_reconciled_gift_id` on every
member of each group with >= 2 members (idempotent: guard `source_group_id IS
NULL`; deterministic id so re-runs are no-ops; `'histgrp_'` prefix can never
collide with the app's random ids).

**Key structural fact:** the legacy representative was `ids.sort()[0]` — a JS
lexicographic (code-unit) sort, which is byte-identical to `MIN(id COLLATE "C")`
that `groupRepresentativeWhere` picks. So the workbench's chosen representative
is ALWAYS the row that carries `matched_gift_id` → which the queue already
excludes as "done." Result: after the backfill the orphan cards collapse and the
whole group drops out of the active queue (verified on prod read-only: 19 groups,
35 leaks → 0 cards). No code change needed; the latent missing-`group_reconciled`
exclusion is made moot for these rows.

**How to apply:** this is a PROD data change → idempotent SQL file in
`lib/db/migrations/` applied by a human (agent can't write prod). Dev's
`staged_payments` are stale (excluded from prod→dev sync) so dev validates
mechanics/idempotency only; validate the leak→0 OUTCOME by simulating the
post-backfill query against prod read-only.
