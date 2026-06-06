---
name: Deleting a gift requires removing allocations first
description: gift_allocations FK is RESTRICT; delete handler must clear allocations in a txn before deleting the gift
---

`gift_allocations.gift_id` → `gifts_and_payments.id` is **onDelete: restrict**
(allocations are money-trail line items). Every gift carries at least one
allocation row, so a raw `DELETE FROM gifts_and_payments` fails the FK for
essentially ANY gift. The delete route must clear the gift's `gift_allocations`
rows first, in the same transaction.

**Why:** a fundraiser merging two gifts into one (move allocations onto gift A,
then delete gift B) hit a 500 — the route deleted the gift directly and the
RESTRICT FK rejected it. Surfaced via production deployment logs, not dev.

**How to apply:** the other three FKs to `gifts_and_payments`
(`gift_being_matched_id`, staged_payments `matched_gift_id` / `created_gift_id`)
are all **set null**, so they never block a delete — only `gift_allocations`
does. Deleting a gift that a staged QB payment points at silently nulls that
link (the payment reverts to unresolved); acceptable today but keep in mind if
gift deletion ever needs to warn about QB-reconciled gifts.
