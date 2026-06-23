---
name: payment_applications cash-application ledger
description: The authoritative QB cash-application ledger (M:N staged_payments↔gifts) and its phased, additive-on-live-prod rollout + book-once design.
---

# payment_applications — QuickBooks cash-application ledger

A new authoritative ledger for the many-to-many between QB payment records
(`staged_payments`) and CRM gifts (`gifts_and_payments`). It is meant to RETIRE
the scattered linkage signals (`final_amount_qb_staged_payment_id`,
`matched/created/group_reconciled_gift_id`, `staged_payment_splits`).

## Rollout discipline (phased, additive, on LIVE prod — never big-bang)
1. Additive schema + write helper with **zero callers** (no behavior change).
2. Dual-write from every QB write path + idempotent backfill (still READING legacy).
3. Parity gates, then flip READS to `SUM(amount_applied)` (keep dual-write for rollback).
4. Deprecate legacy cols/tables; DROP only much later, never while live code/prod reads them.

**Why phased:** prod holds live money data and the agent cannot write prod —
every behavior/data change needs explicit human sign-off + a reviewed idempotent
SQL file. The user gates each phase; do not roll T002+ behavior changes (e.g.
stopping `stampGiftFinalAmount` from overwriting `gift.amount`, the prod backfill)
into the additive phase.

## Scope decision (firm)
Strictly **QB cash-application**: a row exists only once QB settles a gift. No row
for pre-QB Stripe, hand-entered, or off-books money. Tie status is derived from the
ledger: `tie` = `SUM(amount_applied)` within fee band of `gift.amount`,
`missing` = no rows, `amount_mismatch` otherwise; off-books gifts are exempt.
Refunds/chargebacks are a deliberately separate later phase.

## Book-once invariant lives in the SERVICE layer (not the DB)
Enforced by: `UNIQUE(payment_id, gift_id)` + a tx `SELECT ... FOR UPDATE` on the
staged payment + a live `SUM(amount_applied)` over OTHER gifts ≤ payment amount +
tolerance. There is deliberately **NO DB aggregate / fee-band CHECK constraint**.
**Why:** the over-application tolerance is a fee-band for gross-over-net splits
(split callers pass a wider tolerance than the default epsilon), which a static
CHECK can't express. An unknown payment amount can't prove over-application, so it
passes. Keep correctness in `applyPaymentApplication` + parity tests, not the DB.

## gift_id is ON DELETE RESTRICT → hard-delete gift paths must handle the ledger
Any path that HARD-deletes a `gifts_and_payments` row must clear/handle ledger rows
first. The three known paths: (a) **gift merge BLOCKS (409)** a loser that carries
a ledger row — it does NOT repoint — to preserve settlement/audit history;
(b) QB revert clears ledger rows before deleting its auto-minted gift; (c) Stripe
revert clears before deleting its minted gift. If you add a new gift hard-delete
path, it must clear ledger rows or it will hit the RESTRICT FK once the table has
rows. `mergeEntities` FK-inventory test needs NO entry — the ledger has no
org/person/household donor FK.

## Migration / deploy ordering
Table is created by a reviewed idempotent SQL file in `lib/db/migrations/` (not by
trusting the Publish diff, which can abort on the unrelated `conditions_met` drift
and skip additive creates). Apply the SQL to prod **before** the code that
references the table goes live — even Phase 1's merge guard queries the table on
every gift merge, so a live-code-before-table window 500s with
`relation "payment_applications" does not exist`.

## Confirmation is a SEPARATE state transition that must promote provenance
`match_method` has three states (`system` → auto-applied by worker/rule;
`system_confirmed` → a human graduated that auto-match; `human` → human-created).
Dual-write is not just "write a row" — when a fundraiser confirms an auto-match
(the confirm-match handlers that stamp `staged_payments.match_confirmed_*`), the
ledger rows for that payment must be promoted `system` → `system_confirmed`
(stamping `confirmed_by`/`confirmed_at`, never touching amount/gift link). Do this
inside the same `db.transaction` as the staged-row update, with one shared `now`.
Promotion is scoped `WHERE payment_id = ? AND match_method = 'system'` so it is a
no-op for `human`/already-`system_confirmed`/no-ledger rows (idempotent on
re-confirm). **Why:** the architect FAILED a "dual-write done" claim that wrote
`system`/`human` but never promoted on confirm — provenance silently went stale and
audit couldn't tell auto-from-confirmed. The backfill CASE must mirror this exactly
(`auto_applied AND match_confirmed_at` ⇒ `system_confirmed`), or historical rows
disagree with live writes.

## Untouched by design
`pledgeStage.ts` pledge `paid_amount` (SUM of `gifts_and_payments.amount` on the
pledge, excluding archived) is a separate 1:N and is NOT folded into the ledger.
