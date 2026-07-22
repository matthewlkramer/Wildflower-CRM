---
status: current-status
last_verified: 2026-07-22
verification_basis: >
  Relationship-authority table and derived-status claims verified against code
  on 2026-07-21 (commit d68abae9). Drift items are labeled individually:
  "ratified drift" items were confirmed against code and ratified by the owner
  on 2026-07-21; "flagged" items came from an external documentation review and
  must be re-verified against code before any repair work.
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
| Payment/evidence unit → CRM gift | `payment_applications` (`link_role='counted'`); QB reads flipped to the ledger; Stripe/Donorbox still read their row-level pointer columns while the ledger dual-writes |
| Stripe payout → QuickBooks deposit | `settlement_links` (`lifecycle`: `proposed`/`confirmed`/`exempt`; `exempt` = human-confirmed "no deposit expected" — Stripe balance withdrawal / negative or failed payout — with a NULL deposit pointer) |
| Evidence ↔ evidence (cross-source) | **Not implemented.** `source_links` is an approved ADR only ([`adr-source-link-ledger.md`](adr-source-link-ledger.md)); the existing source-specific claim pointers are FROZEN — never add a sibling pointer |
| Gift ↔ QB tie signal | Live-derived at read time (`deriveGiftQbTieLiveExpr` in `giftQbTie.ts`); the stored `quickbooks_tie_status` column and its applier were retired — there is no recompute call site |
| Staged/charge statuses | Derived from facts via the shared builders in `derivedStatus.ts`; no stored status columns (Donorbox's stored lifecycle is mapped to the shared vocabulary at every emit point). A QB deposit claimed by a confirmed settlement link or confirmed charge tie derives `excluded` (settled by the Stripe side; no stored `exclusion_reason`). A stored exclusion does NOT disqualify a deposit from settlement matching — exclusion and settlement eligibility are independent facts |
| Workbench UI | The cluster view is the current design, superseding the older six-queue workbench described in earlier documents |
| Manual gift creation on a pledge | Blocked at `POST /gifts-and-payments` (`manual_gift_on_pledge_blocked`, Task #788) — pledge payments are minted from QuickBooks evidence via reconciliation. Sole escape hatch: the explicit finance-gated `offBooksException` request flag (money that never hits QuickBooks); the flag is never persisted. Minted gifts inherit scope from the pledge's remaining plan (`copyPledgeAllocationsToGift`, stamped via `gift_allocations.source_pledge_allocation_id`) |

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

## Maintenance

- When a drift item is repaired, delete it here and update
  `last_verified`.
- When new drift is discovered, add it here in the same change that discovers
  it — labeled with how it was verified.
- Detailed implementation lessons live in
  [`../.agents/memory/money-sync-reconciliation.md`](../.agents/memory/money-sync-reconciliation.md).
