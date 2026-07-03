---
name: unit_groups additive dual-write (reconciliation WS2)
description: The first-class polymorphic unit_groups association that generalizes staged_payments.source_group_id — how the additive dual-write phase stays drift-safe before reads flip.
---

# unit_groups additive dual-write (reconciliation WS2)

`unit_groups` + `unit_group_members` generalize the sync-owned
`staged_payments.source_group_id` grouping into a first-class, polymorphic
association (membership keyed by `(evidence_source, source_id)` with **no FK** on
`source_id`; `UNIQUE(evidence_source, source_id)` enforces a unit belongs to at
most one group). It reuses the existing `payment_application_evidence_source` enum.

## The rule
While in the dual-write phase, **every writer of `source_group_id` must mirror the
same change into `unit_groups`/`unit_group_members` inside the SAME transaction.**
Reads are NOT flipped onto the new table yet — that is a strictly-later,
prod-parity-gated step.

**Why:** the whole point of an additive dual-write is that the two representations
never diverge, so a future read-flip is provably safe. A single out-of-band
`source_group_id` mutation (a re-pull clobber, a stray delete) would silently drift
the two apart and there is no FK to catch it.

**How to apply:**
- The ONLY writers of `source_group_id` are the group + ungroup handlers in
  `artifacts/api-server/src/routes/quickbooks/actions.ts`. The re-pull upsert
  (`quickbooksSync.ts`) and `revert.ts` do NOT touch grouping, so during dual-write
  there is no path that moves the two apart outside a shared tx. If you ADD a
  `source_group_id` writer, it MUST dual-write.
- Group handler: deterministic id `ug_<sourceGroupId>` (onConflictDoNothing),
  membership recomputed from the **full** post-write `source_group_id` set (not just
  the passed ids) via delete-then-insert — this also self-heals stale rows. This is
  why passing a SUBSET of an existing group still yields full membership, and why
  mixing a grouped pair with an ungrouped unit is a `different_group` 409 (not a
  grow op).
- Ungroup handler: deletes membership for every cleared unit (including the
  auto-cleared orphan when a group falls below two) and deletes the `ug_<g>` row for
  dissolved groups.

## Migration + parity
- `lib/db/migrations/0088_unit_groups.sql` is idempotent (enum guard, CREATE ...
  IF NOT EXISTS, deterministic `ug_<sgid>`/`ugm_<sp.id>` backfill with
  `evidence_source='quickbooks'` from `source_group_id` groups HAVING COUNT>=2,
  ON CONFLICT DO NOTHING). It converges exactly with the runtime dual-write, so
  running it before OR after Publish is safe. Human-applied to prod.
- Parity gate: `pnpm --filter @workspace/api-server run parity:unit-groups` is
  **bidirectional** — `missing_unit_group` + `member_mismatch` cover legacy→new,
  `orphan_unit_group` + `orphan_member` cover new→legacy, plus an exclusivity check.
  It must PASS on **prod** (dev parity ≠ prod) before the Sub-task C read-flip.
- **Gotcha for the next phase:** `orphan_unit_group` only inspects ids `LIKE 'ug_%'`.
  Fine while the only writer mints `ug_` ids; **widen it before introducing any
  non-`ug_` (non-deterministic / cross-source) group id shape** or new-side orphans
  slip through.
