-- Migration 0082: Allocation restriction & coding cleanup (Task #449).
--
-- WHY:
--   1. RESTRICTION TAXONOMY. The coarse "formal_*" restriction booleans
--      (gift_allocations.formal_regional_restriction / formal_fund_use_restriction
--      and pledge_allocations.formally_restricted) plus the old restriction_type
--      enum can't express the donor's actual restriction INTENT per axis. They are
--      replaced by three independent axes — regional_restriction_type /
--      usage_restriction_type / time_restriction_type — each
--      restriction_axis ('donor_restricted' | 'wf_restricted' | 'unrestricted'),
--      NOT NULL default 'unrestricted'.
--   2. CODING SNAPSHOT MOVED. The derived revenue-coding snapshot (object_code +
--      override, revenue_location + override, revenue_class + override,
--      coding_flags, deferred_revenue, deferred_revenue_reason) describes a
--      QuickBooks PAYMENT, not the donor's intent, so it moves OFF both allocation
--      tables ONTO staged_payments. The allocation can still GENERATE a coding
--      preview on demand from its scope (deriveRevenueCoding) but no longer
--      persists one. (Default = RE-DERIVE; no snapshot copy — see "Coding" below.)
--   3. CONDITIONS MOVED. Grant conditions move from the opportunity HEADER
--      (opportunities_and_pledges.conditional / conditions / conditions_met) DOWN
--      onto pledge_allocations (where money is booked per year / tranche). The
--      header now exposes a READ-ONLY derived rollup of these. This file copies the
--      header values down before those header columns are (eventually) retired.
--   4. RENAME reimbursable_share -> reimbursement_type (the pg enum TYPE and the
--      column on both allocation tables). Values unchanged ('direct' | 'indirect').
--
-- ORDERING (IMPORTANT — read the RUNBOOK):
--   Apply this file to prod BEFORE Publish. A column/type RENAME cannot ship safely
--   through the non-interactive Publish (drizzle) diff (it would be seen as
--   drop+add and LOSE data). Running this file first renames in place and creates
--   every new additive column/type with IF NOT EXISTS guards, so the subsequent
--   Publish diff is a no-op for these tables. The whole file is idempotent and safe
--   to re-run, and is also safe to run AFTER Publish (every CREATE/ADD is guarded).
--
-- IDEMPOTENCY / SAFETY:
--   * Every CREATE TYPE / ADD COLUMN / RENAME is guarded (IF NOT EXISTS / existence
--     check), so the file is self-contained and re-runnable.
--   * Each backfill UPDATE is guarded on the target still holding its default, so on
--     the SAME source state a re-run re-applies the identical set (a no-op). It is a
--     one-time file by intent: do NOT re-run after an admin manually edits a
--     restriction axis / condition, or it could re-stamp that intentional edit.
--   * The deprecated columns are kept @deprecated in the Drizzle schema so Publish
--     never proposes dropping them. Their physical DROP is the DEFERRED, COMMENTED
--     section 4 below (run by hand later, in lockstep with removing the @deprecated
--     columns from the schema). Mirrors invariant #7 + the 0080 pattern.
--
-- Run from the repo root:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0082_allocation_restriction_and_coding_cleanup.sql
-- (No BEGIN/COMMIT in the file — the `-1` flag wraps the whole run in one txn.)

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. SCHEMA SAFETY — types, RENAME, additive columns (all guarded)
-- ─────────────────────────────────────────────────────────────────────────────

-- 0a. New enum type: restriction_axis.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'restriction_axis') THEN
    CREATE TYPE restriction_axis AS ENUM
      ('donor_restricted', 'wf_restricted', 'unrestricted');
  END IF;
END $$;

-- 0b. RENAME the enum TYPE reimbursable_share -> reimbursement_type (guarded:
--     only when the old name still exists and the new one does not).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reimbursable_share')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reimbursement_type') THEN
    ALTER TYPE reimbursable_share RENAME TO reimbursement_type;
  END IF;
END $$;

-- 0c. RENAME the column reimbursable_share -> reimbursement_type on both
--     allocation tables (guarded per table).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'gift_allocations' AND column_name = 'reimbursable_share')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'gift_allocations' AND column_name = 'reimbursement_type') THEN
    ALTER TABLE gift_allocations RENAME COLUMN reimbursable_share TO reimbursement_type;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'pledge_allocations' AND column_name = 'reimbursable_share')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'pledge_allocations' AND column_name = 'reimbursement_type') THEN
    ALTER TABLE pledge_allocations RENAME COLUMN reimbursable_share TO reimbursement_type;
  END IF;
END $$;

-- 0d. Restriction-axis columns on gift_allocations (NOT NULL default unrestricted).
ALTER TABLE gift_allocations
  ADD COLUMN IF NOT EXISTS regional_restriction_type restriction_axis NOT NULL DEFAULT 'unrestricted',
  ADD COLUMN IF NOT EXISTS usage_restriction_type    restriction_axis NOT NULL DEFAULT 'unrestricted',
  ADD COLUMN IF NOT EXISTS time_restriction_type     restriction_axis NOT NULL DEFAULT 'unrestricted';

-- 0e. Restriction-axis columns + grant-condition columns on pledge_allocations.
--     (pledge_allocations.conditions text already exists — contingency free-text.)
ALTER TABLE pledge_allocations
  ADD COLUMN IF NOT EXISTS regional_restriction_type restriction_axis NOT NULL DEFAULT 'unrestricted',
  ADD COLUMN IF NOT EXISTS usage_restriction_type    restriction_axis NOT NULL DEFAULT 'unrestricted',
  ADD COLUMN IF NOT EXISTS time_restriction_type     restriction_axis NOT NULL DEFAULT 'unrestricted',
  ADD COLUMN IF NOT EXISTS conditional               opportunity_conditional,
  ADD COLUMN IF NOT EXISTS conditions_met            opportunity_conditions_met NOT NULL DEFAULT 'no';

-- 0f. Revenue-coding snapshot columns on staged_payments (the QuickBooks payment).
ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS object_code               text,
  ADD COLUMN IF NOT EXISTS object_code_override      text,
  ADD COLUMN IF NOT EXISTS revenue_location          text,
  ADD COLUMN IF NOT EXISTS revenue_location_override text,
  ADD COLUMN IF NOT EXISTS revenue_class             text,
  ADD COLUMN IF NOT EXISTS revenue_class_override    text,
  ADD COLUMN IF NOT EXISTS coding_flags              text[],
  ADD COLUMN IF NOT EXISTS deferred_revenue          deferred_revenue,
  ADD COLUMN IF NOT EXISTS deferred_revenue_reason   text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. DATA BACKFILL — restriction axes from the old formal_* booleans
-- ─────────────────────────────────────────────────────────────────────────────

-- 1a. GIFT allocations: regional axis from formal_regional_restriction.
UPDATE gift_allocations
   SET regional_restriction_type = 'donor_restricted'
 WHERE formal_regional_restriction = true
   AND regional_restriction_type = 'unrestricted';

-- 1b. GIFT allocations: usage axis from formal_fund_use_restriction.
UPDATE gift_allocations
   SET usage_restriction_type = 'donor_restricted'
 WHERE formal_fund_use_restriction = true
   AND usage_restriction_type = 'unrestricted';

-- 1c. PLEDGE allocations: the single formally_restricted flag can't distinguish
--     axes, so map it to the USAGE axis (regional + time stay unrestricted).
UPDATE pledge_allocations
   SET usage_restriction_type = 'donor_restricted'
 WHERE formally_restricted = true
   AND usage_restriction_type = 'unrestricted';

-- 1d. TIME axis: all existing rows default to 'unrestricted' (no source signal) —
--     handled by the column DEFAULT in 0d/0e; no UPDATE needed.

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. DATA BACKFILL — copy grant conditions from the opportunity HEADER down onto
--    that opportunity/pledge's allocation rows. Guarded so existing allocation
--    values are never clobbered (idempotent).
-- ─────────────────────────────────────────────────────────────────────────────

-- 2a. conditional: copy where the allocation is still unset and the header has one.
UPDATE pledge_allocations pa
   SET conditional = o.conditional
  FROM opportunities_and_pledges o
 WHERE pa.pledge_or_opportunity_id = o.id
   AND pa.conditional IS NULL
   AND o.conditional IS NOT NULL;

-- 2b. conditions (free-text): copy only where the allocation has none, so existing
--     per-tranche contingency text is preserved.
UPDATE pledge_allocations pa
   SET conditions = o.conditions
  FROM opportunities_and_pledges o
 WHERE pa.pledge_or_opportunity_id = o.id
   AND pa.conditions IS NULL
   AND o.conditions IS NOT NULL;

-- 2c. conditions_met: copy where the allocation still holds the 'no' default and
--     the header carries a non-default value.
UPDATE pledge_allocations pa
   SET conditions_met = o.conditions_met
  FROM opportunities_and_pledges o
 WHERE pa.pledge_or_opportunity_id = o.id
   AND pa.conditions_met = 'no'
   AND o.conditions_met <> 'no';

-- ─────────────────────────────────────────────────────────────────────────────
-- Coding snapshot: RE-DERIVE, do NOT copy.
--   The old allocation coding columns (object_code, revenue_location,
--   revenue_class, coding_flags, deferred_revenue*) were DERIVED data, not
--   donor-entered facts, and the new home (staged_payments) is keyed to a
--   QuickBooks PAYMENT — a 1:1 allocation->staged link does not generally exist.
--   The coding preview is now produced on demand from allocation scope
--   (deriveRevenueCoding) and the reviewer captures it onto the staged row in the
--   reconciliation workbench. So there is intentionally NO allocation->staged
--   coding copy here. The deprecated allocation coding columns are dropped in
--   section 4.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. OPERATOR REPORT (non-aborting) — verify the CSP/CMO restricted rows landed.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  g_regional   int;
  g_usage      int;
  p_usage      int;
  pa_cond      int;
  g_formal_un  int;
  p_formal_un  int;
BEGIN
  SELECT count(*) INTO g_regional FROM gift_allocations
    WHERE regional_restriction_type = 'donor_restricted';
  SELECT count(*) INTO g_usage FROM gift_allocations
    WHERE usage_restriction_type = 'donor_restricted';
  SELECT count(*) INTO p_usage FROM pledge_allocations
    WHERE usage_restriction_type = 'donor_restricted';
  SELECT count(*) INTO pa_cond FROM pledge_allocations
    WHERE conditional IS NOT NULL;
  -- Un-propagated signal (should be 0): a formal_* flag set but axis still unrestricted.
  SELECT count(*) INTO g_formal_un FROM gift_allocations
    WHERE (formal_regional_restriction = true AND regional_restriction_type = 'unrestricted')
       OR (formal_fund_use_restriction = true AND usage_restriction_type = 'unrestricted');
  SELECT count(*) INTO p_formal_un FROM pledge_allocations
    WHERE formally_restricted = true AND usage_restriction_type = 'unrestricted';

  RAISE NOTICE '0082 report: gift donor_restricted regional=% usage=%, pledge donor_restricted usage=%, pledge w/ conditional=%',
    g_regional, g_usage, p_usage, pa_cond;
  RAISE NOTICE '0082 report: UN-PROPAGATED formal flags (must be 0): gift=%, pledge=%',
    g_formal_un, p_formal_un;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. DEFERRED, COMMENTED-OUT — physical DROP of the deprecated columns.
--    Run by hand, SEPARATELY and LATER, only after the new code is deployed and
--    section 3 reports un-propagated = 0, AND in the SAME change that removes the
--    matching @deprecated columns from the Drizzle schema (so dev and prod stay in
--    lockstep — see invariant #7 + the post-merge push-abort note).
-- ─────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE gift_allocations
--   DROP COLUMN IF EXISTS formal_regional_restriction,
--   DROP COLUMN IF EXISTS formal_fund_use_restriction,
--   DROP COLUMN IF EXISTS restriction_type,
--   DROP COLUMN IF EXISTS restriction_evidence,
--   DROP COLUMN IF EXISTS deferred_revenue,
--   DROP COLUMN IF EXISTS deferred_revenue_reason,
--   DROP COLUMN IF EXISTS object_code,
--   DROP COLUMN IF EXISTS object_code_override,
--   DROP COLUMN IF EXISTS revenue_location,
--   DROP COLUMN IF EXISTS revenue_location_override,
--   DROP COLUMN IF EXISTS revenue_class,
--   DROP COLUMN IF EXISTS revenue_class_override,
--   DROP COLUMN IF EXISTS coding_flags;
-- ALTER TABLE pledge_allocations
--   DROP COLUMN IF EXISTS formally_restricted,
--   DROP COLUMN IF EXISTS restriction_type,
--   DROP COLUMN IF EXISTS restriction_evidence,
--   DROP COLUMN IF EXISTS deferred_revenue,
--   DROP COLUMN IF EXISTS deferred_revenue_reason,
--   DROP COLUMN IF EXISTS object_code,
--   DROP COLUMN IF EXISTS object_code_override,
--   DROP COLUMN IF EXISTS revenue_location,
--   DROP COLUMN IF EXISTS revenue_location_override,
--   DROP COLUMN IF EXISTS revenue_class,
--   DROP COLUMN IF EXISTS revenue_class_override,
--   DROP COLUMN IF EXISTS coding_flags;
-- -- The opportunity HEADER conditional/conditions/conditions_met columns are kept
-- -- physical (they back the derived rollup's source until a later cleanup); the
-- -- app no longer WRITES them. Drop them only in a separate, reviewed change.
