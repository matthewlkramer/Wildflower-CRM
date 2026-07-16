---
name: Test-data hygiene (dev DB pollution)
description: Three recurring patterns that leave orphan rows in the dev DB after killed test runs, and the cleanup recipe for each. All look like code regressions but are data contamination.
---

Killed vitest / e2e runs (CPU throttling is the primary cause in this environment) abort
before `afterAll` cleanup runs. Check these three patterns whenever a test fails
"for no reason" after a previous interrupted run.

---

## 1. e2e test users pollute the owner filter ("Test Dev" / "Test Admin")

`testClerkAuth` sign-ins with `@wildflowerschools.org` emails auto-provision user rows
via `requireAuth`. These named rows ("Test Dev" / "Test Admin") clutter the owner
dropdown. They WILL reappear after any future e2e run — expected, not a bug.

**Cleanup:**
```sql
-- Clear RESTRICT-blocking notes first (typically e2e notes)
DELETE FROM notes
  WHERE (body ILIKE '%E2E note%' OR body ILIKE '%e2e%')
    AND user_id IN (
      SELECT id FROM users
      WHERE first_name ILIKE 'Test' AND last_name IN ('Dev', 'Admin')
    );
-- Then archive the test users (NOT hard-delete)
UPDATE users SET archived_at = NOW()
  WHERE first_name ILIKE 'Test' AND last_name IN ('Dev', 'Admin');
```

Or run `pnpm --filter @workspace/scripts run cleanup:test-users`.

**Gotcha — archived user blocks the next run:** `cleanup:test-users` ARCHIVES (not
deletes) Test Dev/Admin rows. A later `testClerkAuth` sign-in gets `403 user_archived`
and list pages show "0 total". Fix before re-running e2e:
```sql
UPDATE users SET archived_at = NULL WHERE email ILIKE 'testdev@wildflowerschools.org';
```
Then re-run `cleanup:test-users` after the e2e run to re-archive.

**Canonical predicate** (must stay in sync in TWO places simultaneously):
`first_name ILIKE 'Test' AND last_name IN ('Dev', 'Admin')` — lives in
`scripts/src/cleanup-test-users.ts` AND the admin email-intel `reviewerSource` filter
(`GET /admin/email-intel/feedback`). Change in one → change in the other or they drift.

The nameless `user_...@unknown.com` rows have no usable identity and are already filtered
from the owner dropdown — leave them.

---

## 2. Far-future (2099) seed rows crowd proximity-ordered searches

Reconciliation integration suites seed gifts / staged payments / charges with far-future
dates (~2099) to stay clear of real data, and clean up in `afterAll`. Killed runs leave
them in the dev DB.

**Symptom:** `reconciliation-search-split.integration.test.ts` (or any test using a
date-proximity-ordered, LIMIT'd search anchored near 2099) fails deterministically —
leftover rows from OTHER suites sit closer to the anchor and crowd the expected candidate
out of `LIMIT 25`. The failure looks like a code regression but reproduces even on
untouched search code.

**Cleanup** (in FK order — delete everything in the far-future band; no legitimate data
lives in `2098-01-01` to `2100-12-31`):
1. `payment_applications` — by `gift_id` AND by `payment_id` for all rows in the band
2. `settlement_links` — by `deposit_staged_payment_id` (a CHECK constraint forbids the
   ON DELETE SET NULL path when status is `confirmed`, so this must be explicit)
3. `staged_payments`, `stripe_staged_charges` — in the date band
4. `gift_allocations` (by `gift_id`), then `gifts_and_payments` — where
   `date_received BETWEEN '2098-01-01' AND '2100-12-31'`

Re-run the failing file in isolation after cleanup to confirm.

---

## 3. dupspec phone constants crowd the potential-duplicates queue

Potential-duplicates integration tests seed orgs / people / phones with per-run unique
IDs (`dupspec_<ts>_*`) but **reused** literal phone constants (e.g. `+1 (555) 010-5555`)
across runs. Killed runs leave rows that share the same phone across runs, producing
O(N²) cross-run pairs at `PHONE_ONLY_SCORE`. The queue sorts by score and slices to the
200-row cap, so the current run's seeded phone-pair tests get crowded out.

**Symptom:** exactly two phone-signal tests fail ("unsafe pair" / "shared phone") while
the other 21 pass.

**Cleanup** (in FK order, all rows matching `id LIKE 'dupspec%'`):
```sql
DELETE FROM duplicate_dismissals
  WHERE id LIKE 'dupspec%' OR id_a LIKE 'dupspec%' OR id_b LIKE 'dupspec%';
DELETE FROM gift_allocations
  WHERE gift_id IN (SELECT id FROM gifts_and_payments WHERE id LIKE 'dupspec%');
DELETE FROM gifts_and_payments WHERE id LIKE 'dupspec%';
DELETE FROM emails WHERE id LIKE 'dupspec%';
DELETE FROM phone_numbers WHERE id LIKE 'dupspec%';
DELETE FROM organizations WHERE id LIKE 'dupspec%';
DELETE FROM people WHERE id LIKE 'dupspec%';
DELETE FROM users WHERE id LIKE 'dupspec%';
```

Re-run the failing suite after cleanup.

**Related:** the validation harness runs `codegen:check` concurrently with test suites,
which transiently deletes `generated/` dirs → false "Cannot find module './generated'"
failures in UNRELATED test files. Re-run those files sequentially before treating as real.
