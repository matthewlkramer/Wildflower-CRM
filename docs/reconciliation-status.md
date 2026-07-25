---
status: current-status
last_verified: 2026-07-23
verification_basis: >
  Bank-spine landing and relationship-authority claims verified against code
  on 2026-07-23. Drift items are labeled individually: "ratified drift" items
  were confirmed against code and ratified by the owner; "flagged" items came
  from an external documentation review and must be re-verified against code
  before any repair work.
---

# Reconciliation — Current Implementation Status

This document describes what is actually implemented today and where it is
known or suspected to differ from the ratified semantics in
[`workbench-business-rules.md`](workbench-business-rules.md). It is
descriptive, not normative. Do not extend a drift listed here; repair the
canonical boundary first (see `replit.md`).

## Relationship authority (verified)

| Relationship | Authority today |
|---|---|
| Payment/evidence unit → CRM gift | `payment_applications` anchored **solely by `payment_unit_id`** (`link_role='counted'`); each component/payment unit has zero or one counted gift. The three source-anchor columns and their legacy indexes are dropped. QB/Stripe/Donorbox no longer read row-level pointer columns, and `payment_units` are minted eagerly at booking. Apparent multiple gifts on one unit are repaired by merging into allocation rows on one gift; there is no deposit→gift link. |
| Stripe payout → bank deposit | `stripe_payouts.bank_deposit_id`, a recomputed deterministic pairing with `ambiguous_bank_match` and `bank_matched_at`; there is no lifecycle or confirmation workflow. `settlement_links` is retired and dropped (0169); the historical QBO pairing fact lives on `staged_payments.settled_stripe_payout_id`. |
| Evidence ↔ evidence (cross-source) | `source_links` — implemented and sole authority ([`adr-source-link-ledger.md`](adr-source-link-ledger.md), phases 1–6 complete; the old source-specific pointer columns were physically dropped in migration 0149). Never add a sibling pointer column |
| Gift ↔ QB tie signal | Live-derived at read time (`deriveGiftQbTieLiveExpr` in `giftQbTie.ts`); the stored `quickbooks_tie_status` column and its applier were retired — there is no recompute call site |
| Staged/charge statuses | Derived from facts via the shared builders in `derivedStatus.ts`; no stored status columns (Donorbox's stored lifecycle is mapped to the shared vocabulary at every emit point). Deposit-header and derived-excluded logic remain for historical/accounting evidence. The current deposit-level `bank_deposit_exclusions` row is the PR #42 implementation being migrated to component/payment-unit exclusion; target deposit not-fundraising state is derived when all components are excluded. Excluded components remain visible and badged. |
| Workbench UI | The deposit-first four-column workbench at `/reconciliation/deposits` is the current default: **Bank \| Composition \| Gifts \| Accounting**. Columns 2–4 are row-aligned per component/payment unit; QBO is derived documentation. `/reconciliation` and `/reconciliation-workbench` redirect there; `/reconciliation/clusters` remains a secondary view, and the old six-queue workbench is retired. |
| Manual gift creation on a pledge | Blocked at `POST /gifts-and-payments` (`manual_gift_on_pledge_blocked`, Task #788) — pledge payments are minted from QuickBooks evidence via reconciliation. Sole escape hatch: the explicit finance-gated `offBooksException` request flag (money that never hits QuickBooks); the flag is never persisted. Minted gifts inherit scope from the pledge's remaining plan (`copyPledgeAllocationsToGift`, stamped via `gift_allocations.source_pledge_allocation_id`) |
| Several QB rows → one gift | `POST /quickbooks/staged-payments/multi-match` writes N `payment_applications` counted rows atomically (no `unit_group` row; open to all team members — CRM-side matching; zero-amount members rejected at selection). Unit groups are fully retired ([`adr-linear-money-model.md`](adr-linear-money-model.md) §7 step 3 done): nothing reads or writes `unit_groups` / `unit_group_members`; `/group`, `/group-reconcile`, `/ungroup`, and `/:id/eject-from-group` are 410 `group_creation_retired` tombstones; per-row revert is the single undo path. Legacy rows sit inert until step 4 verifies and drops the tables |

## Bank-spine cutover — landed

The bank-spine cutover landed across PRs **#34–#42**. `bank_deposits` are the
money spine; `payment_units` are canonical donor-level payment identities;
`payment_applications` is anchored solely by `payment_unit_id`; the legacy
source-anchor columns are dropped; `settlement_links` is retired; and the
finance-gated UI #1 deposit-exclusion action writes only
`bank_deposit_exclusions`. The deposit-first four-column workbench is the
default reconciliation surface.

Migrations **0179→0180→0181→0182→Publish→0183** were the human-gated final
steps and are **applied to production** (owner-confirmed 2026-07-23).

## UI #2 component-grain target

The locked design target makes the component/payment unit the true grain for
the workbench:

- A deposit decomposes into components; Composition, Gifts, and Accounting are
  row-aligned per component.
- Each component has zero or one counted gift application. Multiple apparent
  gifts are merged into allocation rows on one gift; deposit→gift is not
  modeled.
- Excluded components remain visible with an **Excluded** badge.
- QBO remains downstream documentation through typed `source_links` claims and
  `deposit_qbo_components`; gift/allocation↔QBO is derived transitively, with
  no direct gift↔QBO or general M:N link.
- “No expected bank deposit” for balance withdrawals, net ≤ 0, and failed
  payouts is derived, not a routine manual bundle action.
- Unresolved remainders target two flows: a needs-research placeholder, or a
  known component that first searches unclaimed check payment units and only
  creates a fresh unit if none matches, with optional QBO attachment or a
  missing-QBO annotation.

The component-grain exclusion migration, placeholder/known-component creation,
per-component QBO rollup and backward attach, and accounting-check disposition
write action remain target work. No direct `qbo_accounting_checks` disposition
endpoint exists today.

## Ratified rules with known or suspected implementation gaps

### 1. Refund confirmation mutates the CRM gift — RATIFIED DRIFT (verified)

Implemented: Stripe refund/chargeback propagation is propose-then-confirm; on
confirm, a full refund or chargeback archives the CRM gift and a partial refund
reduces its amount, then re-derives the linked pledge.

Ratified (2026-07-21): a processed refund removes or reduces live payment
evidence only. It does not, by itself, archive the gift, rewrite donor intent,
or prove the gift was never paid. Gift disposition after a refund is a separate
human decision (complete/re-collect/lost/dormant), taken with the refund fact
visible.

Consequence: do not extend the confirm-mutates-gift path. Repair direction:
keep the evidence-side refund fact and the human confirm step; stop
auto-archiving/reducing the gift; surface the affected row for an explicit
disposition decision.

### 2. No anticipatory refund state — RATIFIED (audit before assuming compliant)

Ratified (2026-07-21): there is no `refund_anticipated` state or action.
Records stay exactly as they are until a refund is actually processed. Verify
no anticipatory state exists anywhere before building on this; never add one.

### 3. A pledge alone is never complete — RATIFIED (audit implementation)

Ratified (2026-07-21): CRM completeness requires a CRM gift/payment. A pledge
by itself cannot be complete — pledge allocation rows are intentions ("hopes"),
gift/payment allocation rows are authoritative. Audit any completeness
derivation that could mark a pledge-only row complete.

### 4. Lost/dormant records never render as CRM cards — RATIFIED (audit implementation)

Ratified (2026-07-21): CRM cards represent only gifts believed won. A lost or
dormant record must never render as a CRM card; the mark-lost/mark-dormant
disposition actions remain, and taking them removes the card from the
workbench. Audit card-rendering paths for compliance.

### 5. `audit_ready` semantics — flagged by external review, verify before repair

Ratified meaning: `audit_ready` requires the required QuickBooks documentation
to be complete, not merely the presence of accounting evidence. The system
never writes to QuickBooks (pull-only); QB-side documentation is done by a
human in QuickBooks. External review flagged that the current derivation may
treat evidence presence as sufficient. Verify against code before repairing.

### 6. One canonical row state — flagged by external review, verify before repair

Ratified: completed-lens membership, counts, displayed status, and available
actions must all derive from the same canonical row state. External review
flagged possible parallel derivations. Verify before repairing; if confirmed,
consolidate to one derivation rather than patching the divergent copy.

### 7. Donorbox is donor/purpose evidence — flagged by external review, verify before repair

Ratified: Donorbox is donor/purpose evidence, not transaction evidence (the
underlying transaction is Stripe/PayPal/ACH/check). External review flagged
surfaces that may treat Donorbox rows as transaction evidence. Verify before
repairing.

## Pending historical repair — migration 0154 (awaiting human run)

`lib/db/migrations/0154_historical_charge_qb_ties.sql` fixes the audited
historical Stripe-charge ↔ QuickBooks cases from
`exports/stripe-payout-qb-audit.md`: splits two bundled QB rows into
reconciliation units, writes 20 confirmed charge ties (+1 fee-row claim) — including
re-pointing the crosswise Gang-charge→Macdonald tie so the Scholes and Gang
charges each line up against their own QB row — applies the retroactive
charge-tie supersede ledger moves/demotes (four of which repair live
double-counts), and fixes four settlement links. It must be run by a human
AFTER Publish applies the 0153 schema. Rehearsed on a scratch DB (end state
verified, idempotent re-run). No human-review residual remains. Delete this
section once 0154 has been applied to production.

## Maintenance

- When a drift item is repaired, delete it here and update
  `last_verified`.
- When new drift is discovered, add it here in the same change that discovers
  it — labeled with how it was verified.
- Detailed implementation lessons live in
  [`../.agents/memory/money-sync-reconciliation.md`](../.agents/memory/money-sync-reconciliation.md).
