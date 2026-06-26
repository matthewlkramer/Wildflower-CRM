-- Migration 0080: Move "counts toward goal" from the gift HEADER (and from
-- staged_payments) DOWN onto gift_allocations — and retire the never-shipped
-- staged_payments.sync_gap annotation.
--
-- WHY:
--   "Counts toward goal" is inherently an ALLOCATION-level fact: one gift can
--   split across funds / fiscal years where some money advances a fundraising
--   goal and some (e.g. a government-reimbursement line) does not. The analytics
--   goal rollups now read gift_allocations.counts_toward_goal; the duplicate
--   header flag on gifts_and_payments and the copy on staged_payments are
--   retired. The staged_payments.sync_gap annotation (added in 0074 — no UI/API
--   ever shipped) is removed end-to-end at the same time.
--
-- WHAT THIS FILE DOES:
--   0. Schema safety: ADD COLUMN IF NOT EXISTS gift_allocations.counts_toward_goal.
--   1. One-time DATA backfill: propagate every existing "non-goal" signal (a
--      gift header flagged false, OR a linked staged row flagged non-goal) DOWN
--      onto that gift's allocations. The staged link is followed through ALL five
--      staged->gift paths (the 3 direct columns + staged_payment_splits + the
--      payment_applications ledger) so no resolution shape is missed. Monotonic
--      (only ever sets false) + guarded on the allocation still being true, so
--      re-running BEFORE any manual re-include is a no-op.
--   2. Operator report (non-aborting).
--   3. DEFERRED, COMMENTED-OUT drop of the three retired columns (run by hand,
--      separately, only after the new code is deployed — see invariant #7).
--
-- PUBLISH ORDERING (invariant #7): the new gift_allocations.counts_toward_goal
--   column reaches prod via the normal Publish (drizzle) diff. The
--   ADD COLUMN IF NOT EXISTS below makes this file self-contained and safe to run
--   whether or not Publish has already added the column. The three RETIRED
--   columns are kept @deprecated in the Drizzle schema (so Publish never proposes
--   dropping them and aborting the additive diff — see the post-merge push-abort
--   note); their physical DROP is the separate, manual step in section 3.
--
-- IDEMPOTENCY / SAFETY:
--   * The backfill only ever flips counts_toward_goal true -> false, and only for
--     allocations still true, so on the SAME source state re-running re-applies the
--     identical set (a no-op). Mirrors the monotonic, source-keyed pattern of 0072
--     step 3b — deliberately no marker table (Publish-safe).
--   * One-time by intent (NOT safe to re-run after manual edits): if an admin LATER
--     manually re-includes a reimbursement allocation (sets it back to true), do
--     NOT re-run this file — like every monotonic one-time backfill it would
--     re-flip that intentional edit back to false. Run it ONCE, right after the
--     column is added.
--   * NOTHING is dropped by the un-commented portion of this file.
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0080_counts_toward_goal_to_allocations.sql
--
-- Run with `-1` (psql wraps the whole file in ONE transaction). Do NOT add an
-- internal BEGIN/COMMIT — `-1` already provides the single-transaction guarantee.

-- ─── 0. Schema safety (idempotent) ─────────────────────────────────────────
ALTER TABLE gift_allocations
  ADD COLUMN IF NOT EXISTS counts_toward_goal boolean NOT NULL DEFAULT true;

-- ─── 1. Backfill: propagate every "non-goal" signal down to the allocations ──

-- 1a. Gift HEADER flagged non-goal -> all of its allocations non-goal. Covers
--     every gift minted with counts_toward_goal=false: manual reimbursement
--     gifts, and QB / worker mints that copied a non-goal staged row onto the
--     header.
UPDATE gift_allocations ga
   SET counts_toward_goal = false, updated_at = now()
  FROM gifts_and_payments g
 WHERE ga.gift_id = g.id
   AND g.counts_toward_goal = false
   AND ga.counts_toward_goal = true;

-- 1b. Linked STAGED row flagged non-goal -> that gift's allocations non-goal.
--     Catches pre-0072 government-reimbursement (e.g. payer "CSP") gifts whose
--     header was minted as true but whose staged row 0072 step 3b later flipped
--     to false. The gift is reached through any of the three staged->gift links.
UPDATE gift_allocations ga
   SET counts_toward_goal = false, updated_at = now()
  FROM staged_payments sp
 WHERE sp.counts_toward_goal = false
   AND ga.counts_toward_goal = true
   AND (ga.gift_id = sp.created_gift_id
     OR ga.gift_id = sp.matched_gift_id
     OR ga.gift_id = sp.group_reconciled_gift_id);

-- 1c. Same staged signal, but for gifts resolved through the two NEWER linkage
--     tables: a split-reconciled staged row (one Stripe-payout lump → many gifts)
--     carries NONE of the three direct columns above (its resolution lives only
--     in staged_payment_splits), and the payment_applications cash-application
--     ledger is an independent M:N staged↔gift link. Without this, a non-goal
--     staged row resolved that way would leave its gift's allocations counting.
--     Guarded by to_regclass: payment_applications is a phased-rollout table that
--     may not exist in every environment yet, and EXECUTE keeps this file
--     parseable when it is absent.
DO $$
BEGIN
  IF to_regclass('public.staged_payment_splits') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE gift_allocations ga
         SET counts_toward_goal = false, updated_at = now()
        FROM staged_payment_splits sps
        JOIN staged_payments sp ON sp.id = sps.staged_payment_id
       WHERE sp.counts_toward_goal = false
         AND ga.gift_id = sps.gift_id
         AND ga.counts_toward_goal = true
    $sql$;
  END IF;

  IF to_regclass('public.payment_applications') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE gift_allocations ga
         SET counts_toward_goal = false, updated_at = now()
        FROM payment_applications pa
        JOIN staged_payments sp ON sp.id = pa.payment_id
       WHERE sp.counts_toward_goal = false
         AND ga.gift_id = pa.gift_id
         AND ga.counts_toward_goal = true
    $sql$;
  END IF;
END $$;

-- ─── 2. Operator report (non-aborting) ─────────────────────────────────────
DO $$
DECLARE
  n_alloc_total   int;
  n_alloc_nongoal int;
  n_gift_nongoal  int;
  n_unpropagated  int;
BEGIN
  SELECT count(*) INTO n_alloc_total   FROM gift_allocations;
  SELECT count(*) INTO n_alloc_nongoal FROM gift_allocations WHERE counts_toward_goal = false;
  SELECT count(*) INTO n_gift_nongoal  FROM gifts_and_payments WHERE counts_toward_goal = false;
  -- Any gift-header non-goal whose allocations were NOT all propagated = leftover
  -- (expect 0 after this run).
  SELECT count(*) INTO n_unpropagated
    FROM gift_allocations ga
    JOIN gifts_and_payments g ON g.id = ga.gift_id
   WHERE g.counts_toward_goal = false
     AND ga.counts_toward_goal = true;
  RAISE NOTICE '0080: allocations total=%, non-goal=%, gift-header non-goal=%, un-propagated header rows=% (expect 0)',
    n_alloc_total, n_alloc_nongoal, n_gift_nongoal, n_unpropagated;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. DEFERRED — physically DROP the three retired columns. DO NOT run as part of
--    the rollout. Keep them @deprecated in the Drizzle schema until this runs
--    (so Publish never proposes the drop and aborts the additive diff — see the
--    post-merge push-abort note). Run by hand, in its own reviewed migration,
--    ONLY after the new code (which no longer reads/writes them) is deployed and
--    the section-2 report shows un-propagated = 0:
--
--   ALTER TABLE gifts_and_payments DROP COLUMN IF EXISTS counts_toward_goal;
--   ALTER TABLE staged_payments    DROP COLUMN IF EXISTS counts_toward_goal;
--   ALTER TABLE staged_payments    DROP COLUMN IF EXISTS sync_gap;
--
--   (Remove the matching @deprecated columns from the Drizzle schema in the SAME
--    change so dev and prod stay in lockstep.)
-- ════════════════════════════════════════════════════════════════════════════
