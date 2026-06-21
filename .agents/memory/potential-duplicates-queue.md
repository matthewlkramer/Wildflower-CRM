---
name: Potential-duplicates queue (C8)
description: How the admin duplicate-detection queue scores/merges pairs and the gotchas that keep it correct.
---

# Potential-duplicates queue

Admin-only feature: detect likely-duplicate organizations/people, then merge or dismiss.

## Scoring invariant (the gotcha)
Signals are name-similarity (pg_trgm `similarity()`) + shared-phone. The phone bonus
must contribute **once per entity pair**, but two entities can share the *same*
normalized phone across multiple `phone_numbers` rows — a naive self-join returns one
row per shared-phone, inflating the score.

**Why:** repeated `PHONE_BONUS` per pair distorts ranking/score.
**How to apply:** the phone-pair self-join must collapse to one row per pair
(`groupBy(col1, col2)` / `SELECT DISTINCT`) before merging into the score map. Keep an
eye on this any time the detection query is touched.

## Other durable constraints
- Dismiss persists to a `duplicate_dismissals` table keyed on canonicalized ids
  (`id_a < id_b`) so dismissed pairs never reappear; the endpoint is idempotent (204).
- Detection excludes archived rows and dismissed pairs; results are score-ordered.
- Name masking: the list response masks `DuplicatePairSide.name` via the shared
  identity-visibility helper (defensive — route is admin-only, but keeps the invariant).
- Frontend reuses the shared `MergeDialog`; per-type "merge launcher" child components
  load the two full records on demand (separate org/person hook paths). Merge + dismiss
  invalidate with the full `"/api/potential-duplicates"` query-key prefix.

## Safe-merge / one-click + bulk
- A pair is **safe** when the two records have NO scalar field holding two distinct
  non-empty values — identical or null-vs-filled only. The comparison set is the merge
  engine's `overrideFields` whitelist (imported, never re-listed) so detection and the
  merge it triggers stay in lockstep. **Array columns are skipped** (the engine unions
  them losslessly, so a difference there is never a conflict).
  **Why:** auto-merging a pair where both sides hold a real, different value would
  silently destroy data — only blank-vs-filled is reconcilable without a human.
- The API returns `safeMerge` + `mergeSuggestion {primaryId, mergeIds, overrides}` per
  pair. Survivor pick: most gifts → earliest `createdAt` → smaller id. Overrides take the
  loser's filled value for every field the survivor left blank. Logic is the pure,
  exported `computeSafeMerge` in `routes/potentialDuplicates.ts` (unit-testable, DB-free).
- UI: per-pair **Quick merge** is truly one-click (no confirm); batch ops (merge-all,
  bulk-merge-selected, bulk-dismiss) go through one `AlertDialog`. Bulk merge only ever
  touches the **safe** subset of the selection; unsafe selected pairs are skipped.
- **Load-gate** (mirrors `bulk-action-load-gate`): bulk submit is disabled until every
  selected key resolves to a loaded pair (`selectedPairs.length === selection.count`).
  This page has no pagination, so an effect prunes selection keys that no longer resolve
  (pair vanished post-merge) — but never mid-batch (failed rows stay selected to retry).
- Deviation from the list pages: this page does NOT reuse `BulkActionBar` (its
  Edit/Merge/Archive + count≥2 record semantics don't fit pair-selection); it has a
  dedicated inline selection bar instead.
