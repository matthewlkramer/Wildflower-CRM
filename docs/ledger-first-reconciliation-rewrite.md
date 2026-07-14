# Ledger-first reconciliation rewrite

**Status:** implementation branch; not production-ready.

## Objective

Make the two link ledgers the only operational relationship model:

- `settlement_links` owns Stripe payout ↔ QuickBooks deposit settlement.
- `payment_applications` owns unit ↔ CRM gift relationships for QuickBooks, Stripe, and Donorbox.
- CRM gifts remain the sole donor-credit records.
- Legacy evidence-row gift pointers remain physical and deprecated during the transition, but are removed from operational reads and writes.

## Safety rules

1. No production data is changed by application startup or background code.
2. Production repairs are reviewed, idempotent SQL migrations with fail-fast preconditions.
3. Read cutovers follow parity audits; they do not precede them.
4. Proposed applications never enter monetary sums or book-once calculations.
5. Only confirmed, counted applications contribute to settled gross.
6. Corroborating applications never contribute to monetary sums.
7. A Stripe charge or non-Stripe Donorbox donation may have at most one active counted gift application.
8. Every user-confirmed relationship mutation carries exact immutable source and gift IDs.

## Phase 0 — baseline and exception inventory

Preserve read-only audit queries and before-state exports for:

- ledger/pointer disagreements;
- counted applications with missing anchors;
- evidence units with more than one counted gift;
- gifts claimed by multiple non-splittable units;
- unit over-application;
- confirmed settlements with legacy disagreement;
- resolved records still appearing in unresolved queues;
- evidence donor versus gift donor mismatches;
- stale `match_status` metadata with no pointer or ledger relationship.

Every anomaly must be classified as deterministic repair, human review, or documented inert legacy metadata.

## Phase 1 — application lifecycle semantics

`payment_applications.lifecycle` becomes operational:

- `proposed`: suggested relationship; does not count money;
- `confirmed`: settled relationship; counts only when `link_role='counted'`;
- `exempt`: retained audit relationship that does not participate in active matching.

All settled-gross, fee, tie, queue, and book-once readers must filter both:

```sql
link_role = 'counted' AND lifecycle = 'confirmed'
```

Auto-match writes a proposed application. Confirmation promotes that same row. Rejection removes or exempts it. Retargeting replaces the prior proposal transactionally.

## Phase 2 — pointer retirement

Flip readers before stopping writers.

### Stripe and Donorbox

Replace `matched_gift_id` / `created_gift_id` reads with ledger queries in:

- gift payment summaries;
- derived evidence status;
- reconciliation cards and missing-side queues;
- refund propagation;
- sync/rematch guards;
- lineage;
- gift merge/combine;
- financial corrections;
- API response projections.

Then stop writes to the deprecated columns. Expose a ledger-derived `linkedGiftId` where clients require a display relationship.

### QuickBooks

QuickBooks pointer retirement is a separate gate because direct, created, and group-reconciled pointers are still used by current status and grouped reconciliation paths. It is not considered complete until those paths derive entirely from applications and durable unit grouping.

## Phase 3 — one-count settlement supersession

For a confirmed payout ↔ deposit settlement, compare each confirmed counted QuickBooks deposit application to confirmed counted Stripe charge applications from that payout **for the same gift**.

When Stripe coverage matches the QuickBooks application within the shared fee-band rule:

- demote the coarse QuickBooks application from `counted` to `corroborating`;
- record that settlement supersession caused the demotion;
- recompute the gift tie/status.

When coverage later disappears, promote only rows previously demoted by settlement supersession. Unrelated corroborating applications must never be promoted.

The recompute must be idempotent, bidirectional, collision-safe, and invoked after every settlement, charge application, QuickBooks application, revert, refund, and gift-merge mutation that can change coverage.

## Phase 4 — production repair

A reviewed migration mirrors the deployed supersession rule exactly. It must:

- preserve before-state;
- validate expected row counts and identities;
- demote proven duplicate QuickBooks applications;
- clear only mechanically obsolete conflict remnants;
- repair deterministic missing ledger rows;
- avoid backfilling retired pointers;
- recompute derived/persisted tie fields;
- emit unresolved partial/ambiguous rows for manual review;
- be a no-op on its second execution.

## Current branch progress

The first foundational slice makes `giftPaymentSummary.ts` ledger-authoritative:

- all three evidence sources are read through `payment_applications`;
- only confirmed counted rows contribute;
- Stripe and Donorbox fees are joined through ledger anchors;
- Donorbox-through-Stripe enrichment rows are excluded;
- legacy gift pointers are no longer used by this summary.

This branch remains draft until lifecycle-aware book-once behavior, status derivation, pointer retirement, supersession, regression tests, and the production repair migration are implemented and verified.
