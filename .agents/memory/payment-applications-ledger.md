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

## Extended to Stripe + Donorbox (polymorphic anchor, still QB-read-only)
The ledger is now dual-written for three evidence sources (`evidence_source`
enum: `quickbooks` | `stripe` | `donorbox`), each with its own anchor column
(`payment_id` / `stripe_charge_id` / `donorbox_donation_id`). **Only the QB
readers were flipped to read the ledger** — Stripe/Donorbox rows are written for
parity/future-read but not yet read. Provenance rules: every Stripe settle sets
exactly one of matched/created gift ptr (nulls the other) and revert clears both
+ removes ledger rows, so anchor↔ledger stay lockstep; the Donorbox gift ptr is
set ONLY by the two human routes (link/mint) — enrich/suggest never set it, so
enrich-only donations are correctly excluded from the ledger.

## Backfill provenance (Stripe/Donorbox, one-time SQL)
gift = `COALESCE(matched_gift_id, created_gift_id)`; amount = stripe `gross_amount`
/ donorbox `amount`; `created_the_gift` = `created_gift_id IS NOT NULL`;
`match_method` = `human` (Donorbox) or auto→`system`/else`human` (Stripe, no
confirm-promotion in the Stripe model). Idempotent via `ON CONFLICT (anchor, gift_id)
DO NOTHING`. Backfill is **one-time** — rows created AFTER it (e.g. new test
fixtures) have no ledger row until the dual-write runs.

## Parity gate exits 1 on DEV purely from vitest fixtures — NOT a regression
`parity-payment-applications.ts` (the dedicated ledger gate; blocking) reports
real-data parity clean but the overall gate exits 1 on dev because leftover
epoch-timestamped vitest fixtures (`qbsplit_*` / `reconanchor_*` / `reconapv_*`)
`db.insert` charge/donation gift-pointers directly, bypassing the dual-write
applier — so they legitimately have a pointer with no ledger row. **Re-running
vitest injects fresh anchor orphans.** On prod (no fixtures) the one-time backfill
covers all existing settled anchors and the dual-write covers new ones, so the
gate is clean there. Don't chase these as bugs; clean/exclude fixtures if the
noise ever masks a real dev regression. The gate's own raw ledger SQL filters
`link_role='counted'` to stay aligned with the readers once Phase-5 corroborating
rows land.

## Prod schema lagged dev (push-only cols) — needed a hand-applied prep file
The polymorphic-ledger deltas — `link_role`, `lifecycle` (+ their enums),
`payment_id` DROP NOT NULL, and the PARTIAL UNIQUE book-once indexes on
`(stripe_charge_id,gift_id)` / `(donorbox_donation_id,gift_id)` — reached DEV
only via `drizzle-kit push` with **no reviewed migration SQL file**. 0065
(`CREATE TABLE IF NOT EXISTS`) can't retrofit an existing prod table, so prod
still had `payment_id NOT NULL` and none of the above. Two hard consequences:
the deployed readers filter `link_role='counted'` (missing column ⇒ 500) and
0086's `ON CONFLICT (<anchor>,gift_id)` needs the partial unique index to exist
(missing ⇒ "no unique or exclusion constraint matching the ON CONFLICT spec").
Fix: a hand-applied idempotent prep file (0087) applied to prod BEFORE Publish
and BEFORE 0086. **Prod deploy order for this feature: 0087 (schema prep) →
Publish (code) → 0086 (backfill).**
**Why:** every ledger column that lives only in the Drizzle schema is invisible
to prod until a reviewed SQL file ships it; the Publish diff is distrusted here
(0065's own header). **How to apply:** before telling anyone a backfill is
"runnable on prod," verify each column/index it depends on actually exists in
prod (read-only query), don't assume drizzle push == prod.

## Untouched by design
`pledgeStage.ts` pledge `paid_amount` (SUM of `gifts_and_payments.amount` on the
pledge, excluding archived) is a separate 1:N and is NOT folded into the ledger.
