---
name: Killed test runs pollute the potential-duplicates queue
description: Leftover dupspec_* seed rows from killed vitest runs make potentialDuplicates tests fail; clean by deleting LIKE 'dupspec%' across tables.
---

The potential-duplicates integration tests seed orgs/people/phones with per-run
unique IDs (`dupspec_<ts>_*`) but REUSED literal phone-number values (e.g.
"+1 (555) 010-5555") across runs. `afterAll` cleanup never runs when the
sandbox kills vitest mid-run (CPU throttling), so leftovers accumulate.

**Why it breaks:** every leftover run's orgs share the same phone constants, so
the phone-pair self-join produces O(N²) cross-run pairs, all at
PHONE_ONLY_SCORE. The queue sorts by score and slices to the 200 cap, so the
CURRENT run's seeded phone-only pair (the "unsafe pair"/"shared phone" tests)
gets crowded out → `expected undefined to be defined` on exactly those two
tests while the other 21 pass.

**How to fix:** delete leftovers in FK order, then re-run:
`duplicate_dismissals (id/id_a/id_b LIKE 'dupspec%')` → `gift_allocations
(gift_id LIKE)` → `gifts_and_payments` → `emails` → `phone_numbers` →
`organizations` → `people` → `users` (all `id LIKE 'dupspec%'`).

Related: validation-harness runs `codegen:check` concurrently with test suites,
which transiently deletes `generated/` dirs → false "Cannot find module
'./generated'" failures in UNRELATED test files; re-run those files
sequentially to confirm they pass before treating them as real.
