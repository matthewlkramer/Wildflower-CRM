---
name: QuickBooks deposit grouping (staged-payments reconciler)
description: Manual grouping of staged payments sharing one bank deposit, reconciled as a whole to one existing gift.
---

# QuickBooks deposit grouping

Fundraisers MANUALLY group several QB staged payments and match the group to ONE
existing CRM gift. Fee-band gated (combined member total ≈ gift amount),
reversible, idempotent under re-sync. No auto-grouping, no mint, no QB writeback.

## Grouping key (deposit OR payer; date NOT in the key)
A group is coherent when members share ONE grouping key:
- `dep:<qbDepositId>` when a deposit was captured, OR
- `payer:<payer>` (trimmed+lowercased, non-empty) — used ONLY when **every**
  member has a null `qbDepositId`. **Date is NOT part of the key** (a single
  wire, or a series of stock sales, can span several days — e.g. Arthur Rock
  2018-05-22 → 06-15 = one $1M gift).

**Why:** many real rows (Wend, Walton, Chan Zuckerberg, Arthur Rock, Howley) are
one gift split across several QB records with NO captured deposit; gating on
same-day blocked the multi-day stock-sale cases.

**Cross-date confirmation gate:** because payer-only grouping could collapse
unrelated same-payer gifts (recurring donations), the server throws
`400 multi_date_confirmation_required` when the members span >1 distinct
`date_received` and the body's `confirmMultiDate !== true`. The client detects
the span and opens a confirm dialog, then resends with `confirmMultiDate:true`.

**Lockstep invariants** (client `groupKeyOf`/`groupSpansMultipleDates` ↔ server
guard — the server is the real boundary, a direct API call must not bypass):
- payer fallback gated on `allDepositNull` on BOTH sides (else different known
  deposits could be force-grouped by shared payer).
- multi-date detection must count `null` date as its OWN distinct bucket on
  BOTH sides (`new Set(map(r => r.dateReceived ?? null)).size > 1`). If the
  client drops nulls (e.g. `filter(Boolean)`) it diverges: a mixed null+real
  group opens no dialog yet the server always 400s → operator stranded.
All other gates (pending-only, fee-band tolerance, gift single-donor XOR,
gift-not-already-linked, partial-unique index) are unchanged.

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
