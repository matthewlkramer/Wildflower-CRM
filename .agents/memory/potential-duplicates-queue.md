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
