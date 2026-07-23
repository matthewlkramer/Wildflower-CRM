---
name: Staged-payment funding source + same-physical-gift grouping
description: Reconciliation — what funding_source means and how provenance protects manual edits. The grouping half (source_group_id, group-approve) is HISTORICAL — column dropped, group creation retired.
---

# Staged-payment funding source + same-physical-gift grouping

Two reconciliation concepts on `staged_payments`, both purely additive.

## funding_source (money ORIGIN)

- `funding_source` enum (`stripe | brokerage | daf | donorbox | paypal | wire_ach | check | cash | employer_match | other`), NULLABLE.
- It is **WHERE the money came from / how it rendered** — deliberately distinct from two look-alikes:
  - `qb_payment_method` = the QuickBooks `PaymentMethodRef` instrument (e.g. "Visa"). Instrument, not origin.
  - the derived reconciliation **funding lane** = reconcile *progress*, not origin.
- Auto-seeded at ingest by a pure `detectFundingSource(input)` (Stripe evidence → stripe; intermediary type → daf/donorbox/paypal/brokerage; qbPaymentMethod → check/cash/wire_ach; memo fallback). **Returns null on unknown — never guesses.**
- `funding_source_provenance` (`auto | manual`, NOT NULL default `auto`) protects a human edit from re-pull clobber. **Why:** mirrors the existing `entity_source` provenance pattern — the ingest upsert (and any reclassify path) must `CASE WHEN ...provenance='manual' THEN <keep> ELSE <new>` so a corrected value survives the next sync. **How to apply:** any new write path touching `funding_source` must respect the manual guard; the backfill (`backfill:funding-source`) is auto-only.

## source_group_id (one physical gift, many QB records) — HISTORICAL

**Update 2026-07-23:** `source_group_id` was DROPPED (0104, replaced by
`unit_groups`), and new group creation has since been retired entirely —
"several QB rows are one gift" is now expressed as N counted
`payment_applications` rows written atomically by
`POST /quickbooks/staged-payments/multi-match`, with no group record.
`unit_groups` survives only for legacy groups and is slated for retirement
(`docs/adr-linear-money-model.md` §7 step 3). Kept for context:

- Shared opaque id tying **separately-entered QuickBooks records that are really ONE physical gift**, grouping freely across different bank deposits AND dates.
- **Pure human review state — the sync NEVER writes it.** Group/ungroup are explicit human endpoints; ungroup auto-dissolves a group left with <2 members; grouping requires >=2 and 400s `donor_conflict` (unless `confirmDonorConflict`).
- The card route collapses a `source_group_id` set into ONE group card (deterministic representative = MIN id; SUM of member amounts).

## Group-approve atomicity (the invariant to protect) — mechanism retired, lesson lives on

**Update 2026-07-23:** the representative/`groupReconciledGiftId` mint is gone
(endpoint 410). The invariant transferred to multi-match: all N counted ledger
rows are written in ONE transaction with locked, re-checked members and count
guards, so a half-reconciled set still cannot double-book money. Original note:

Approving a group mints **ONE** gift: the representative carries `createdGiftId` (owns the mint); every OTHER member ties to it via `groupReconciledGiftId` so no slice can be re-reconciled into a second gift.
**Why:** a half-reconciled group double-books money. Members are locked `FOR UPDATE` + re-checked approvable up front, but the member UPDATE must still `.returning()` and assert `count === otherIds.length`, else throw 409 to roll back the gift + representative. **How to apply:** mirror the representative update's count guard on the `otherIds` update — both pure review-state group/ungroup writes are already FOR-UPDATE+count guarded.
