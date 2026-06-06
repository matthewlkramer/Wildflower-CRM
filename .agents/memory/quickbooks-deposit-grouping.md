---
name: QuickBooks deposit grouping (staged-payments reconciler)
description: Manual grouping of staged payments sharing one bank deposit, reconciled as a whole to one existing gift.
---

# QuickBooks deposit grouping

Fundraisers MANUALLY group several QB staged payments that share ONE bank Deposit
into a "deposit unit" and match the group to ONE existing CRM gift. Fee-band
gated (combined member total ≈ gift amount), reversible, idempotent under
re-sync. No auto-grouping, no mint, no QB writeback, no cross-deposit grouping.

## Representative pattern (key design choice)
ALL group members get `group_reconciled_gift_id = giftId`; only the
**representative** (lowest id, `ids.sort()[0]`) ALSO gets `matched_gift_id =
giftId`. This keeps the gift "linked" through the existing single-link path
(`gift.quickbooksStagedPaymentId`) and reuses existing revert/display, while the
partial-unique `staged_payments_matched_gift_id_uq` is satisfied (only one member
carries matched_gift_id). Members display the gift via the resolved-gift join's
`COALESCE(matched, created, groupReconciled)`. Revert is group-aware: it clears
the WHOLE group (checked FIRST in the revert route).

**Why:** avoids inventing a new "linked" signal and a parallel revert path —
the representative re-uses everything the single-match flow already does.

## qb_deposit_id preserve-on-conflict
`qb_deposit_id` is folded onto SR/Payment lines at pull time (first-deposit-wins
back-index) and onto direct deposit lines (= deposit row Id). The upsert MUST
`coalesce(excluded.qb_deposit_id, stored)` because the bank Deposit can fall
outside the incremental `LastUpdatedTime` watermark window on a re-pull, leaving
the incoming value null — clobbering would break grouping. Same preserve-on-
conflict reasoning as line coding (item/account/class/description).

## Historical rows
Incremental re-sync will NOT backfill `qb_deposit_id` on old rows (their deposit
is out of the watermark window). Grouping simply isn't offered for rows lacking a
deposit id. To enrich the back-catalog do a clean re-ingestion (wipe
staged_payments + reset watermark — 0024 pattern).
