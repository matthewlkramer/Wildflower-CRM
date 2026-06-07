---
name: QuickBooks deposit grouping (staged-payments reconciler)
description: Manual grouping of staged payments sharing one bank deposit, reconciled as a whole to one existing gift.
---

# QuickBooks deposit grouping

Fundraisers MANUALLY group several QB staged payments and match the group to ONE
existing CRM gift. Fee-band gated (combined member total ≈ gift amount),
reversible, idempotent under re-sync. No auto-grouping, no mint, no QB writeback.

## Grouping key (payer-first; deposit fallback; neither date nor deposit in key)
A group is coherent when members share ONE grouping key, payer preferred:
- `payer:<payer>` (trimmed+lowercased, non-empty) — used whenever a payer is
  present, **even when members carry DIFFERENT `qbDepositId`s**, OR
- `dep:<qbDepositId>` when no payer was captured.
**Neither the date NOR the deposit is part of the key** — a series of stock
sales is one gift even though EACH sale settles as its OWN deposit over several
days (e.g. Arthur Rock 2018-05-22 → 06-15, 5 distinct deposits = one ~$1M gift).

**Why payer-first / cross-deposit:** real stock-sale gifts (Arthur Rock, etc.)
land as one bank deposit PER sale, so the old `allDepositNull`-gated payer
fallback never engaged and the operator literally could not group them. Grouping
reconciles to ONE gift with ONE donor, so payer is the correct coherence signal;
deposit is only the fallback for unnamed-payer line items.

**Confirmation gate (date OR deposit boundary):** because payer grouping could
collapse unrelated same-payer gifts (recurring donations) or two genuinely
separate deposits, the server throws `400 multi_date_confirmation_required` when
the members span >1 distinct `date_received` **OR** >1 distinct non-null
`qbDepositId`, and `confirmMultiDate !== true`. A single shared deposit + single
date never prompts. The client detects the span and opens a confirm dialog, then
resends `confirmMultiDate:true`. (Flag name kept as `confirmMultiDate` though it
now also covers the multi-deposit case — no spec change.)

**Lockstep invariants** (client `groupKeyOf`/`groupNeedsConfirm` ↔ server guard —
the server is the real boundary, a direct API call must not bypass):
- BOTH sides compute ONE per-row key (`payer:<payer>` if present else
  `dep:<qbDepositId>` else null) and require all members to share one non-null
  key. Do NOT regress the server to `sameDeposit || samePayer` OR-logic — that
  accepts groups the UI can't assemble (one deposit batching different payers)
  and would let a raw API call collapse two different donors who share a deposit.
- confirm trigger = multi-date OR multi-deposit on BOTH sides; date detection
  counts `null` date as its OWN distinct bucket
  (`new Set(map(r => r.dateReceived ?? null)).size > 1`); deposit detection
  counts only non-null ids (`...filter(d => d != null)).size > 1`). Divergence
  strands the operator (dialog never opens yet server 400s, or vice-versa).
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
