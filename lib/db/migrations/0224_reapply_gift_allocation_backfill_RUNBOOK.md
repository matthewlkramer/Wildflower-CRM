# 0224 — Re-apply the orphan gift-allocation backfill (supersedes 0085)

Data-only production backfill. **Supersedes `0085_backfill_gift_allocations.sql`,
which was never applied to production** (verified 2026-07-31: zero `ga_0085_%`
rows exist there) and can no longer run as written:

1. Migration 0150 renamed `gift_allocations.usage_restriction_type` →
   `other_restriction_type`, so 0085's INSERT column list now errors.
2. `cleanup_queue` has no unique constraint on
   `(target_type, target_id, reason_code)`, so 0085's `ON CONFLICT` clause
   aborts. This file guards with `NOT EXISTS` instead.

Do **not** run 0085. This file applies the same owner-ratified booking (see the
0085 runbook for the full review record) against the current schema.

## Why now

The deposit workbench's "Split into N per-payment gifts and link all" action
409s on a gift with zero allocations (there is no designation to copy). The
Erica Cantoni $17.80 gift the user hit is one of the orphans this file fixes.

## Current state (verified in prod, 2026-07-31)

- 26 of 0085's 32 target gifts still have zero allocations; 6 were resolved by
  hand since July (William Penn $480, Alexander Brown ×3, Erica Cantoni
  $104.70, LaTania Scott $50 — the LaTania *donor name* fix is still pending
  and included here).
- Gift `zOej0Fb5thKhbxQ72zQHO` was renamed "Saint Paul & Minnesota Foundation"
  since 0085 was written, but its donor org is "Scholler Foundation (of Saint
  Paul & MN Foundation)" — same gift, the ratified PA-restricted booking stands.
- Reference data re-verified in prod: entities `black_wildflowers_fund` +
  `wildflower_foundation`; regions PR/MN/CA/CO (PA via 0085-era check); schools
  `rec4k51mmfjrlBfEM` + `recigTQqe0ppRlzcz`; every computed fiscal year
  (fy2018, fy2020–fy2024, fy2026) exists for all 26 orphans, and the insert
  additionally guards `grant_year` on the `fiscal_years` row existing (NULL
  otherwise), matching the app-side seeding.

## Safety

- **Idempotent.** Deterministic ids (`ga_0224_<giftId>`, `em_0224_latania_scott`,
  `cleanup_nr_<giftId>`), every step guarded (`NOT EXISTS` / NULL-name guard).
  Re-running after a successful apply is a no-op.
- **Non-destructive.** No `DELETE`s, no overwrites of existing scope. Gifts that
  already gained an allocation are skipped by the guard.
- `display_usage` is trigger-maintained and not set directly.

## Apply

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0224_reapply_gift_allocation_backfill.sql
```

No `BEGIN/COMMIT` in the file — `psql -1` runs it as one transaction. It prints
a pre-state `NOTICE` and a final `RESULT` `NOTICE`.

## Verify (by state, not clean exit)

Expected on first apply (re-run to confirm the no-op):

- orphan gifts remaining = **0**
- allocations seeded (`ga_0224_%`) = **26** (BWF 3, Foundation 23)
- LaTania named = 1, LaTania email = 1, Alia flagged = 1

Independent re-check:

```sql
-- must be 0
SELECT count(*) FROM gifts_and_payments g
 WHERE g.archived_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g.id);
```

## Rollback

Reviewed data backfill — no automatic rollback. To undo (only if booked wrong):

```sql
DELETE FROM gift_allocations WHERE id LIKE 'ga_0224_%';
-- optionally: DELETE FROM emails WHERE id = 'em_0224_latania_scott';
--             DELETE FROM cleanup_queue WHERE id = 'cleanup_nr_h6aekQnUjy9OuiiC3d03z';
-- (the people name-fix is left in place; re-null only if truly required)
```
