---
name: unit_groups is the sole grouping store (source_group_id retired)
description: The first-class polymorphic unit_groups association fully replaced staged_payments.source_group_id — final state after the read+write flip and column drop.
---

# unit_groups is the sole grouping store

`unit_groups` + `unit_group_members` are the ONLY home for "these evidence units
are really ONE gift" grouping. Membership is polymorphic — keyed by
`(evidence_source, source_id)` with **no FK** on `source_id`;
`UNIQUE(evidence_source, source_id)` enforces a unit belongs to at most one group.
It reuses the `payment_application_evidence_source` enum. QuickBooks staged rows
are `evidence_source='quickbooks'`, `source_id = staged_payments.id`.

## History (dual-write → flip → retire)
The legacy `staged_payments.source_group_id` column (+ its index) was an additive
dual-write mirror during the migration. It has been RETIRED: all reads AND writes
flipped onto `unit_group_members`, then the column + index were dropped from the
Drizzle schema and via idempotent migration `0104_drop_staged_payment_source_group_id.sql`
(Publish-first, DROP COLUMN IF EXISTS; runbook alongside). Do NOT reintroduce a
grouping column on `staged_payments` (or any evidence table).

## Key decision — group identity IS `unit_groups.id`
The group id is now a fresh `ug_<newId()>` (NOT the old deterministic
`ug_<source_group_id>`, since there is no source_group_id anymore). The
group/ungroup endpoints RETURN this `ug_`-prefixed id as `sourceGroupId`, and the
reconciliation-card `sourceGroupId` is a DERIVED subquery returning the same
`unit_groups.id`. So callers/tests must treat the returned `sourceGroupId` as the
unit group id directly — never re-concatenate `ug_${...}`.

## How grouping works now
- **Group** (`quickbooks/actions.ts`): read existing membership from
  `unit_group_members`; if the passed units already belong to one group, reuse it,
  else mint a new `ug_<newId()>` `unit_groups` row; membership recomputed from the
  **full** post-write set (delete-then-insert). Passing a SUBSET of an existing
  group still yields full membership; mixing a grouped pair with an ungrouped unit
  is a `different_group` 409.
- **Ungroup** (`actions.ts`): delete `unit_group_members` for each cleared unit;
  when a group falls below two members, auto-clear the lone orphan (row-locked via
  a join to `staged_payments` FOR UPDATE) and delete the empty `unit_groups` row.
  `dissolvedGroupIds` = the deleted unit group ids.
- **Reads:** `reconciliation/cards.ts` (representative pick, group aggregate,
  `isSourceGroup`, derived `sourceGroupId`) and `reconciliation/bundleAnchors.ts`
  (eligibility = `NOT EXISTS unit_group_members`) both read the new table. Guards
  in `matching.ts`/`approve.ts`/`reconciliationGraph.ts` use
  `lib/unitGroupMembership.ts` helpers (`isGroupMember`, `groupMemberIdsFor`,
  `isQbGroupMemberSql`).

## Obsolete tooling (now deleted)
`parity-unit-groups.ts` / `parity-group-readflip.ts` (one-shot parity gates that
referenced `sp.source_group_id` in raw SQL) were deleted along with their
package.json script entries once the column drop landed — they would have errored
at runtime. Remaining §7 drop candidates are NOT sweepable: `staged_payment_splits`
still backs split-resolved rows, and `processor_payout`/`confirmed_excluded` enum
values are still read by revert paths.
