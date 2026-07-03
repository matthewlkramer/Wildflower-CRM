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
days (a large securities gift can settle as several distinct deposits spanning
weeks, yet is one gift).

**Why payer-first / cross-deposit:** real stock-sale gifts
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
now also covers the multi-deposit case.)

**Amount-mismatch gate (NO override — B1, correct the gift amount instead):**
the fee band is asymmetric on purpose — deposits may land slightly BELOW the gift
(processor fees) but essentially never above (`giftAmt >= sum-0.01 && giftAmt <=
sum*1.1+1`). Appreciated-stock/securities gifts break this: shares are booked at
one value but SELL for more, so combined proceeds exceed the recorded gift (real
case: a securities gift booked at its share value settled ~1.3% higher across its
sales). **The earlier `confirmAmountMismatch` operator override was REMOVED** in
the reconciliation redesign (docs/reconciliation-design.md §4.6b, decision C5/B1):
an out-of-band combined total now returns `400 error:"amount_mismatch"`
(`details:{combinedTotal,giftAmount}`) with NO bypass. The human corrects the
gift's amount to what actually landed, then reconciles (the SUM then falls in
band). Do NOT reintroduce a confirm-override flag. The band gate is unconditional;
`confirmMultiDate` is the ONLY group confirm flag left. Single-row + split
reconcile paths already used the strict `amount_mismatch` (unchanged).
**Why:** one canonical "the money that landed is the truth" rule instead of an
operator bypass that could book a wrong amount.

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

## Workbench: grouped link-to-existing-gift must use group-reconcile (409 trap)
The per-row approve endpoint REJECTS `link_existing_gift` on a row that is part
of a source group — it 409s "this payment is part of a group, link the whole
group" and points at `/staged-payments/group-reconcile`. So the reconciliation
WORKBENCH (separate page from staged-payments.tsx) must detect
`card.isSourceGroup && outcome==="link_existing_gift"` and route through
group-reconcile for EVERY entry path (stage-confirm, re-target-to-gift,
bulk approve-all-high-confidence, one-click confirm-and-apply); non-grouped or
non-link outcomes still use the per-row approve. A shared
`buildGroupedLinkPayload(card, giftId)` returns null for non-group/<2-member
cards and otherwise sets `confirmMultiDate:true` (members lack `qbDepositId`, so
multi-deposit can't be detected client-side — auto-pass is OK for source groups
only). It no longer computes an amountMismatch flag (the override is gone, B1).
**Money safety:** the server is the sole guard for a group-total↔gift amount
mismatch — all client callers just stage/call group-reconcile and let the
`400 amount_mismatch` surface via the shared catch → `extractGateIssues` → toast
(same path that already surfaces `multi_date_confirmation_required`). Bulk approve
now STAGES out-of-band groups (was: silently skipped) and the apply fails visibly
with the corrective message. When staging a grouped link into the tray, clear any
pending staged change keyed on ANY member's stagedPaymentId (not just the
representative) so a member isn't double-applied alongside the group reconcile.
**Why:** without this the operator literally cannot link a grouped card to an
existing gift from the workbench (hard 409); the original report was an $850k
4-payment group.

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

## Bulk confirm of the Auto-matched queue
`POST /staged-payments/confirm-matches` (body `{ids:[]}`) clears the Auto-matched
queue in one call. It is one atomic `UPDATE ... WHERE id IN (...)` whose
predicate MUST stay identical to the single `/:id/confirm-match`
(`num_nonnulls(donor) >= 1` AND `status='pending' OR (status='approved' AND
autoApplied)`), so a raw bulk call can't confirm rows the single button would
reject. Stale/ineligible/missing ids are SILENTLY SKIPPED (filtered by the WHERE,
returned via `RETURNING`) — partial success, never a whole-batch failure.
Response `{confirmedIds, requested}`: `requested` = RAW payload length (counts
duplicates), but the ids fed to the UPDATE are deduped so one row confirms once.
Client (`staged-payments.tsx`): per-card checkbox + select-all bar render ONLY
for `queue==="auto_matched"`; a `rows`-keyed effect prunes the bulk selection to
currently-visible ids so pagination / post-confirm refetch can't carry hidden ids
into a confirm; queue switch clears the selection.

`POST /staged-payments/revert-matches` is the bulk REVERT companion (same bulk
bar, reuses the SAME `bulkSelected` set; "Revert selected" sits next to "Confirm
selected"). It loops the deduped ids and calls the SHARED helper
`revertOneStagedPayment(id)` — the single `/:id/revert` transaction extracted so
both routes stay in lockstep. Two non-obvious invariants: (1) each row reverts in
its OWN transaction so one rollback never undoes another's revert (NOT one giant
batch UPDATE — revert deletes auto-minted gifts and is group/split-aware, so it
can't be a single SQL statement); (2) the helper returns a structured
`{ok}|{reason}` outcome instead of throwing for the expected not-found /
not-revertible cases, so the bulk loop SKIPS those rows; only `__unexpected__`
errors propagate. Revertibility (only `status='approved'` + reconcile/auto-mint/
group/split; manual-created gifts are never revertible) is unchanged.
