---
status: current-status
last_verified: 2026-07-23
---

# Proposal: deposit-first reconciliation workbench

Status: LANDED. The default route is `/reconciliation/deposits`, with four
visible columns: Bank | Composition | Gifts | Accounting. UI #1 (finance/admin
deposit exclusion and return-to-open-queue actions) shipped in PR #42.

The worklist-lens and open-question sections below remain useful design
context; completed items are marked where they differ from the original plan.

---

> **Landed (2026-07-23):** This proposal is now a current-status record for
> the shipped deposit-first workbench. The API and UI cutover are complete;
> the older payout/QBO-anchored workbench is retired as the default.

## Authority ladder (the spec)

The workbench resolves each bank dollar in this priority order:

1. **Stripe → bank deposit** — highest authority; already auto-matched
   (`stripe_payouts.bank_deposit_id`). Stripe always wins over QBO. Whatever a
   Stripe payout composes needs no human review.
2. **Clean chain** — a remaining deposit whose composition maps bank deposit →
   QBO payment → CRM gift with no ambiguity is treated as probably-correct and
   auto-accepted.
3. **Everything else** — no clean chain (unexplained composition, ambiguous
   pairings, QBO donor ≠ CRM donor, leftover M:N) — surfaces in the workbench
   for a human. Not a SQL scrub, not pre-quantified.

## Current sizing (prod, real WF spine)

- **1,348** WF `bank_deposits` (the spine).
- **146** paired to a Stripe payout (ladder rung 1).
- **154** have QBO-inferred `bank_deposit_components` (checks/wires — rung 2
  candidates).
- **1,048** have *no known composition yet* — the real workbench backlog
  (many are small/non-fundraising, or multi-gift bundled deposits).
- `qbo_accounting_checks`: 85 consistent, 3 correction_needed.

Concrete composition example the workbench must unpack: WF 2019-12-17 =
$192,015.14 is one ATM check deposit that is actually **5 separate donor
payments** (Spring Point $60k + Citybridge $44,515.14 + Spring Point $40k +
Branch Alliance $32.5k + Fidelity $15k).

## Why change

The current cluster workbench predates the bank-spine model. Its rows are
anchored on **stripe_payout / qb_record / crm_only** — i.e., on the evidence
sources — and the bank is an attribute (`bankAmount`) hanging off a payout or
QB row. Under the ratified ADR the spine is inverted: **actual bank deposits
are the ground truth**, payment units are the money grains, and QBO is a
downstream accounting record checked by `qbo_accounting_checks`.

The question the workbench should answer per row is no longer "is this staged
payment matched?" but:

> For this dollar that hit the bank: what payment units compose it, is each
> unit booked to a gift, and does the QBO record agree?

## Primary lens: one row per bank deposit

Anchor the main list on `bank_deposits` (1,348 real WF rows in prod; the
payout-paired and clean-chain rows auto-complete and hide behind the default
lens). Each row shows the three stages of the spine left→right:

```
BANK                COMPOSITION                      GIFTS                ACCOUNTING
$4,812.55           Stripe payout po_… (14 charges)  12 booked, 2 open    QBO lump ✓ consistent
Jul 14 · Chase      or: 3 checks + 1 wire            or: unit w/o gift    or: correction_needed
```

Row anatomy (maps to existing data, nothing speculative):

- **Bank column** — deposit amount/date/account (from `bank_deposits`).
- **Composition column** — how the deposit decomposes:
  - a paired Stripe payout (`stripe_payouts.bank_deposit_id`) expands to its
    charges/refunds/adjustments with the money math (gross − fees − refunds +
    adjustments = bank amount; the current gap line survives here);
  - or `bank_deposit_components` → payment units (checks/ACH/wires/other);
  - or *unresolved* — no known composition (the real worklist).
- **Gifts column** — per payment unit: counted `payment_applications` → gift,
  or "needs donor/gift" (reuses today's per-charge card actions unchanged).
- **Accounting column** — the QBO view: the settled lump
  (`settled_stripe_payout_id`) or per-line QB ties, plus the
  `qbo_accounting_checks` disposition (consistent / correction_needed /
  corrected / accepted_historical).

## Worklist lenses (replace the current lens rail)

1. **Unresolved composition** — deposit with dollars not explained by any
   payout or component (incl. the 1 known overallocated deposit).
2. **Ambiguous pairings** — `ambiguous_bank_match` payouts and ambiguous
   component pairings; human picks via the existing Resolve/search dialog.
3. **Needs donor/gift** — a payment unit in this deposit lacks a counted gift
   application (subsumes today's needs_donor_or_gift).
4. **Accounting corrections** — `qbo_accounting_checks.correction_needed`
   (the successor of the settlement queue's judgment, already live).
5. **Refunds** — unchanged.
6. **Completed / Excluded** — unchanged semantics, deposit-rolled.

Dropped: `settlement_gaps` and `conflicts` as separate lenses (both fold into
1/2/4); `crm_only` moves to a secondary tab (below).

## Secondary tabs (money that is not a deposit yet)

- **Undeposited / in flight** — payment units and paid payouts with no bank
  deposit (register export lag, undeposited checks, the 18 unmatched payouts).
  This is today's orphan-payout lane, reframed honestly as "not yet at bank."
- **CRM only** — gifts with no money evidence (unchanged from today).

## What stays exactly as-is

- Per-charge cards, donor resolve, create-gift, exclude/re-include flows.
- The Resolve manual-pick + QuickBooks search escape hatch.
- `viewerCanManageAccounting` gating.
- Recent-changes rail + undo.

## Build plan (each step shippable)

1. **API — DONE**: `GET /workbench/deposits` is the deposit-anchored workbench
   API.
2. **UI — DONE**: the live deposit list and row expansion reuse the existing
   card components. UI #1 adds the finance/admin deposit exclusion controls.
3. **Cutover — DONE**: `/reconciliation/deposits` is the default route;
   `/reconciliation` and `/reconciliation-workbench` redirect to it, and the
   old six-queue workbench is retired.
4. **Still open**: the later `staged_payments` → `qbo_payment_records` rename
   and any remaining accounting-column refinements.

## Open questions for you

- **Resolved:** the default deposit-first route and four-column layout are
  shipped.
- **Resolved:** direct deposit exclusions have a finance/admin picker and
  return-to-open-queue action (PR #42).
- **Still open:** final default-lens policy and the accounting-column
  refinements described above.
