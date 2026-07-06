-- Migration 0102: archive the phantom "award-amount" placeholder gift on
--                 reimbursable pledges that ALSO already carry real
--                 reimbursement checks, then re-derive the affected pledges.
--
-- WHY (the case 0101 deliberately skipped):
--   Migration 0101 only archived a placeholder award-lump gift when it was the
--   SOLE active gift on a reimbursable pledge. That left the messier, more
--   dangerous case untouched: a reimbursable pledge (a pledge whose
--   pledge_allocations carry conditional = 'reimbursable') that has BOTH
--     * a placeholder gift booked for the FULL award amount (no QuickBooks /
--       Stripe / Donorbox evidence — not real money), AND
--     * one or more REAL reimbursement checks already booked as their own 1:1
--       payment gifts (each backed by settlement evidence).
--   Here the placeholder DOUBLE-COUNTS: the pledge's derived paid_amount is the
--   full award PLUS the real checks, so it reads over-paid / fully-paid
--   ('cash_in') and the phantom lump carries quickbooks_tie_status = 'missing'.
--
--   This file ARCHIVES (soft-delete, never hard-delete — invariant #6) that one
--   phantom award lump per pledge, PRESERVES the real checks, then re-derives
--   the affected pledges so paid excludes the archived lump and status
--   re-derives via the same rules the app's deriveOppFields uses. It mirrors
--   0101's re-derivation block exactly.
--
-- WHAT THIS FILE DOES (DATA-only, idempotent, non-destructive):
--   1. Identify the phantom award gifts to archive. Detection is DELIBERATELY
--      CONSERVATIVE — a gift qualifies only when ALL hold:
--        a. it is still active (archived_at IS NULL);
--        b. its opportunity carries at least one reimbursable pledge_allocation
--           (conditional = 'reimbursable');
--        c. the pledge has a positive awarded_amount and the gift.amount EXACTLY
--           equals that award (the "award lump" signature);
--        d. it has NO settlement evidence anywhere — no payment_applications
--           ledger row (QB / Stripe / Donorbox), no legacy final-amount pointer
--           (final_amount_qb_staged_payment_id / final_amount_stripe_charge_id),
--           no staged_payments link (matched / created / group_reconciled), and
--           no stripe_staged_charges link (matched / created);
--        e. it is not entangled in a match / overpay relationship (it neither
--           points at another gift via gift_being_matched_id / overpay_of_gift_id
--           nor is pointed at by one);
--        f. THE MULTI-GIFT DISCRIMINATOR (what separates this from 0101): the
--           pledge has at least one OTHER active gift that DOES carry settlement
--           evidence — i.e. a REAL reimbursement check alongside the lump; AND
--        g. THE AMBIGUITY GUARD: the pledge has EXACTLY ONE such phantom
--           candidate (a single award-amount, no-evidence gift). If two or more
--           award-amount no-evidence gifts sit on the same pledge we cannot tell
--           which is the phantom, so we archive NONE and leave them for manual
--           review.
--   2. Archive each such gift (archived_at = now()). Nothing is hard-deleted.
--   3. Re-derive every affected pledge by mirroring deriveOppFields /
--      applyDerivedOppFields (a raw-SQL data change does NOT run the app's
--      server-side derivation — see .agents/memory/pledge-status-rederivation.md):
--        * paid           = SUM(amount) of the pledge's NON-archived gifts (now
--                           just the real checks, once the lump is archived);
--        * written_pledge = sticky-true; latches true if a grant letter exists and
--                           the money is no longer fully in; never un-latched;
--        * status         = loss_type (if set) ELSE 'cash_in' (paid >= awarded > 0)
--                           ELSE 'pledge' (written_pledge) ELSE 'open';
--        * stage          = 'complete' when won (pledge/cash_in), else a stale
--                           'complete' reverts to 'verbal_confirmation';
--        * win_probability= re-canonicalised ONLY when status/stage changed (or a
--                           pledge's conditional weight changed), exactly as
--                           applyDerivedOppFields does — pledge = 0.90 (0.75 when
--                           the pledge has a genuinely-conditional allocation),
--                           cash_in = 1.00, lost/dormant = 0.00, open = by stage.
--      Only rows whose derived values actually change are updated (no churn).
--
-- IDEMPOTENCY / SAFETY:
--   * Re-running is a no-op: an already-archived phantom has archived_at set, so
--     guard (a) excludes it, the archive UPDATE touches 0 rows, and the
--     re-derivation runs over an empty affected set.
--   * Every guard is an equality / EXISTS / NOT EXISTS over current state, so the
--     result is stable across runs.
--   * SPOT-VERIFY FIRST. Run section 0 (the read-only preview) against
--     $PROD_DATABASE_URL and eyeball the candidates — for each pledge confirm the
--     archived gift is the phantom lump (== award, no evidence) and the preserved
--     sibling checks are the real, evidence-backed money — BEFORE applying
--     sections 2-3.
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0102_archive_reimbursable_placeholder_gifts_multi.sql
--
-- Run with `-1` (psql wraps the whole file in ONE transaction). Do NOT add an
-- internal BEGIN/COMMIT — `-1` already provides the single-transaction guarantee.

-- ─── 1. Collect the phantom award gifts to archive ─────────────────────────
-- ON COMMIT DROP so the temp table lives only for this single `-1` transaction.
--
-- First, every gift matching the award-lump-with-no-evidence signature
-- (guards a-e). This is the same "phantom candidate" shape 0101 uses, minus its
-- sole-active-gift requirement.
CREATE TEMP TABLE _reimb_phantom_candidates ON COMMIT DROP AS
SELECT g.id AS gift_id, g.opportunity_id
FROM gifts_and_payments g
JOIN opportunities_and_pledges o ON o.id = g.opportunity_id
WHERE g.archived_at IS NULL
  -- (b) the pledge is reimbursable
  AND EXISTS (
    SELECT 1 FROM pledge_allocations pa
    WHERE pa.pledge_or_opportunity_id = o.id
      AND pa.conditional = 'reimbursable'
  )
  -- (c) gift.amount exactly equals a positive pledge award (the "award lump")
  AND o.awarded_amount IS NOT NULL
  AND o.awarded_amount > 0
  AND g.amount IS NOT NULL
  AND g.amount = o.awarded_amount
  -- (d) no settlement evidence of any kind
  AND NOT EXISTS (
    SELECT 1 FROM payment_applications pa WHERE pa.gift_id = g.id
  )
  AND g.final_amount_qb_staged_payment_id IS NULL
  AND g.final_amount_stripe_charge_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM staged_payments sp
    WHERE sp.matched_gift_id = g.id
       OR sp.created_gift_id = g.id
       OR sp.group_reconciled_gift_id = g.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM stripe_staged_charges c
    WHERE c.matched_gift_id = g.id
       OR c.created_gift_id = g.id
  )
  -- (e) not entangled in a match / overpay relationship
  AND g.gift_being_matched_id IS NULL
  AND g.overpay_of_gift_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM gifts_and_payments g3
    WHERE g3.gift_being_matched_id = g.id
       OR g3.overpay_of_gift_id = g.id
  );

-- Now keep only the phantom candidates that (f) sit on a pledge which also has a
-- REAL evidence-backed check, and (g) are the UNIQUE phantom candidate on that
-- pledge. This is the entire difference from 0101: 0101 wanted the phantom to be
-- the SOLE active gift; here it must have a real sibling check.
CREATE TEMP TABLE _reimb_multi_gift_phantoms ON COMMIT DROP AS
SELECT c.gift_id, c.opportunity_id
FROM _reimb_phantom_candidates c
WHERE
  -- (f) at least one OTHER active gift on the pledge carries settlement
  --     evidence — a real reimbursement check booked alongside the lump.
  EXISTS (
    SELECT 1
    FROM gifts_and_payments g2
    WHERE g2.opportunity_id = c.opportunity_id
      AND g2.id <> c.gift_id
      AND g2.archived_at IS NULL
      AND (
        EXISTS (SELECT 1 FROM payment_applications pa WHERE pa.gift_id = g2.id)
        OR g2.final_amount_qb_staged_payment_id IS NOT NULL
        OR g2.final_amount_stripe_charge_id IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM staged_payments sp
          WHERE sp.matched_gift_id = g2.id
             OR sp.created_gift_id = g2.id
             OR sp.group_reconciled_gift_id = g2.id
        )
        OR EXISTS (
          SELECT 1 FROM stripe_staged_charges sc
          WHERE sc.matched_gift_id = g2.id
             OR sc.created_gift_id = g2.id
        )
      )
  )
  -- (g) ambiguity guard: this must be the ONLY phantom candidate on the pledge.
  --     Two+ award-amount, no-evidence gifts are indistinguishable, so skip them.
  AND (
    SELECT count(*) FROM _reimb_phantom_candidates c2
    WHERE c2.opportunity_id = c.opportunity_id
  ) = 1;

-- ─── 0. READ-ONLY PREVIEW (spot-verify before applying) ────────────────────
-- Emits one NOTICE per phantom to be archived AND, indented beneath it, each
-- real sibling check that will be PRESERVED — so an operator can confirm the
-- lump-vs-check split per pledge before the archive UPDATE runs in the same
-- transaction. Purely informational — it writes nothing.
DO $$
DECLARE
  r record;
  s record;
  n int;
BEGIN
  SELECT count(*) INTO n FROM _reimb_multi_gift_phantoms;
  RAISE NOTICE '0102 PREVIEW: % phantom award gift(s) will be archived (real checks preserved)', n;
  FOR r IN
    SELECT t.gift_id,
           g.amount,
           o.id  AS opp_id,
           o.name AS opp_name,
           o.awarded_amount,
           COALESCE(org.name, ppl.full_name, hh.name, '(no donor)') AS donor
    FROM _reimb_multi_gift_phantoms t
    JOIN gifts_and_payments g ON g.id = t.gift_id
    JOIN opportunities_and_pledges o ON o.id = t.opportunity_id
    LEFT JOIN organizations org ON org.id = o.organization_id
    LEFT JOIN people ppl ON ppl.id = o.individual_giver_person_id
    LEFT JOIN households hh ON hh.id = o.household_id
    ORDER BY donor, o.name
  LOOP
    RAISE NOTICE 'ARCHIVE phantom gift % | amount % (== award %) | pledge % (%) | donor %',
      r.gift_id, r.amount, r.awarded_amount, r.opp_id, r.opp_name, r.donor;
    FOR s IN
      -- Only the EVIDENCE-BACKED sibling checks (the real money being
      -- preserved). Any evidence-less sibling is not what protects this row —
      -- the discriminator required at least one evidence-backed check — so
      -- listing only those keeps the operator's lump-vs-check review honest.
      SELECT g2.id, g2.amount
      FROM gifts_and_payments g2
      WHERE g2.opportunity_id = r.opp_id
        AND g2.id <> r.gift_id
        AND g2.archived_at IS NULL
        AND (
          EXISTS (SELECT 1 FROM payment_applications pa WHERE pa.gift_id = g2.id)
          OR g2.final_amount_qb_staged_payment_id IS NOT NULL
          OR g2.final_amount_stripe_charge_id IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM staged_payments sp
            WHERE sp.matched_gift_id = g2.id
               OR sp.created_gift_id = g2.id
               OR sp.group_reconciled_gift_id = g2.id
          )
          OR EXISTS (
            SELECT 1 FROM stripe_staged_charges sc
            WHERE sc.matched_gift_id = g2.id
               OR sc.created_gift_id = g2.id
          )
        )
      ORDER BY g2.amount DESC
    LOOP
      RAISE NOTICE '    keep check gift % | amount % (evidence-backed)', s.id, s.amount;
    END LOOP;
  END LOOP;
END $$;

-- ─── 2. Archive the phantom gifts (soft-delete only) ───────────────────────
UPDATE gifts_and_payments g
SET archived_at = now(),
    updated_at = now()
FROM _reimb_multi_gift_phantoms t
WHERE g.id = t.gift_id
  AND g.archived_at IS NULL;

-- ─── 3. Re-derive the affected pledges (mirror deriveOppFields) ────────────
WITH affected AS (
  SELECT DISTINCT opportunity_id AS id
  FROM _reimb_multi_gift_phantoms
  WHERE opportunity_id IS NOT NULL
),
paid_cte AS (
  SELECT a.id,
    COALESCE(
      SUM(g.amount) FILTER (WHERE g.archived_at IS NULL),
      0
    )::numeric(14, 2) AS paid
  FROM affected a
  LEFT JOIN gifts_and_payments g ON g.opportunity_id = a.id
  GROUP BY a.id
),
cond_cte AS (
  -- conditional rollup for win-probability weighting: a pledge is "conditional"
  -- (0.75) only when it has a GENUINELY-conditional allocation. `reimbursable`
  -- and `unconditional` do NOT count (they weight 0.90).
  SELECT a.id,
    EXISTS (
      SELECT 1 FROM pledge_allocations pa
      WHERE pa.pledge_or_opportunity_id = a.id
        AND pa.conditional IN (
          'conditional_unspecified',
          'conditional_on_funder_determination',
          'conditional_on_target'
        )
    ) AS is_conditional
  FROM affected a
),
base AS (
  SELECT
    o.id,
    o.status        AS status_old,
    o.stage         AS stage_old,
    o.written_pledge AS written_pledge_old,
    o.win_probability AS win_prob_old,
    o.paid          AS paid_old,
    o.loss_type,
    o.grant_letter_url,
    o.awarded_amount,
    p.paid,
    c.is_conditional,
    (o.awarded_amount IS NOT NULL AND o.awarded_amount > 0 AND p.paid >= o.awarded_amount) AS fully_paid,
    (
      o.written_pledge
      OR (
        o.grant_letter_url IS NOT NULL
        AND NOT (o.awarded_amount IS NOT NULL AND o.awarded_amount > 0 AND p.paid >= o.awarded_amount)
      )
    ) AS written_pledge_new
  FROM opportunities_and_pledges o
  JOIN paid_cte p ON p.id = o.id
  JOIN cond_cte c ON c.id = o.id
),
statused AS (
  SELECT b.*,
    CASE
      WHEN b.loss_type IN ('dormant', 'lost') THEN b.loss_type::text
      WHEN b.fully_paid THEN 'cash_in'
      WHEN b.written_pledge_new THEN 'pledge'
      ELSE 'open'
    END AS status_new
  FROM base b
),
staged AS (
  SELECT s.*,
    CASE
      WHEN s.status_new IN ('pledge', 'cash_in') THEN 'complete'
      WHEN s.stage_old = 'complete' THEN 'verbal_confirmation'
      ELSE s.stage_old::text
    END AS stage_new
  FROM statused s
),
derived AS (
  SELECT d.*,
    -- canonical win-probability for the NEW (status, stage, conditional)
    CASE
      WHEN d.status_new IN ('lost', 'dormant') THEN '0.0000'
      WHEN d.status_new = 'cash_in' THEN '1.0000'
      WHEN d.status_new = 'pledge' THEN (CASE WHEN d.is_conditional THEN '0.7500' ELSE '0.9000' END)
      ELSE  -- open (or null): by stage
        CASE d.stage_new
          WHEN 'cold_lead' THEN '0.0000'
          WHEN 'warm_lead' THEN '0.0500'
          WHEN 'in_conversation' THEN '0.2000'
          WHEN 'convince' THEN '0.4000'
          WHEN 'probable_renewal' THEN '0.7500'
          WHEN 'verbal_confirmation' THEN '0.9000'
          WHEN 'conditional_commitment' THEN '0.7500'
          WHEN 'written_commitment' THEN '0.9000'
          WHEN 'cash_in' THEN '1.0000'
          WHEN 'complete' THEN '1.0000'
          ELSE NULL
        END
    END AS canonical_wp
  FROM staged d
),
final AS (
  SELECT d.*,
    (d.status_new IS DISTINCT FROM d.status_old::text
     OR d.stage_new IS DISTINCT FROM d.stage_old::text) AS status_or_stage_changed,
    (d.status_new = 'pledge'
     AND d.canonical_wp IS NOT NULL
     AND d.canonical_wp IS DISTINCT FROM d.win_prob_old::text) AS wp_changed
  FROM derived d
)
UPDATE opportunities_and_pledges o
SET
  paid = f.paid,
  status = f.status_new::opportunity_status,
  written_pledge = f.written_pledge_new,
  stage = f.stage_new::opportunity_stage,
  -- Mirror applyDerivedOppFields: re-canonicalise win_probability ONLY when
  -- status/stage changed OR a pledge's conditional weight changed; otherwise
  -- (e.g. only `paid` moved) leave the existing win_probability untouched.
  win_probability = CASE
    WHEN f.status_or_stage_changed OR f.wp_changed
      THEN COALESCE(f.canonical_wp::numeric, o.win_probability)
    ELSE o.win_probability
  END,
  updated_at = now()
FROM final f
WHERE o.id = f.id
  AND (
    o.paid IS DISTINCT FROM f.paid
    OR o.status::text IS DISTINCT FROM f.status_new
    OR o.written_pledge IS DISTINCT FROM f.written_pledge_new
    OR o.stage::text IS DISTINCT FROM f.stage_new
    OR (
      (f.status_or_stage_changed OR f.wp_changed)
      AND o.win_probability IS DISTINCT FROM COALESCE(f.canonical_wp::numeric, o.win_probability)
    )
  );

-- ─── 4. Operator report (non-aborting) ─────────────────────────────────────
DO $$
DECLARE
  n_archived int;
  n_remaining int;
BEGIN
  SELECT count(*) INTO n_archived FROM _reimb_multi_gift_phantoms;

  -- After the archive this should read 0: no active award-lump gift with no
  -- evidence remains on a reimbursable pledge that also carries a real
  -- evidence-backed check and has a single phantom candidate.
  SELECT count(*) INTO n_remaining
  FROM gifts_and_payments g
  JOIN opportunities_and_pledges o ON o.id = g.opportunity_id
  WHERE g.archived_at IS NULL
    AND EXISTS (
      SELECT 1 FROM pledge_allocations pa
      WHERE pa.pledge_or_opportunity_id = o.id
        AND pa.conditional = 'reimbursable'
    )
    AND o.awarded_amount IS NOT NULL
    AND o.awarded_amount > 0
    AND g.amount IS NOT NULL
    AND g.amount = o.awarded_amount
    AND NOT EXISTS (SELECT 1 FROM payment_applications pa WHERE pa.gift_id = g.id)
    AND g.final_amount_qb_staged_payment_id IS NULL
    AND g.final_amount_stripe_charge_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM staged_payments sp
      WHERE sp.matched_gift_id = g.id
         OR sp.created_gift_id = g.id
         OR sp.group_reconciled_gift_id = g.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM stripe_staged_charges c
      WHERE c.matched_gift_id = g.id OR c.created_gift_id = g.id
    )
    AND g.gift_being_matched_id IS NULL
    AND g.overpay_of_gift_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM gifts_and_payments g3
      WHERE g3.gift_being_matched_id = g.id OR g3.overpay_of_gift_id = g.id
    )
    -- multi-gift discriminator: a real evidence-backed sibling check exists
    AND EXISTS (
      SELECT 1 FROM gifts_and_payments g2
      WHERE g2.opportunity_id = o.id
        AND g2.id <> g.id
        AND g2.archived_at IS NULL
        AND (
          EXISTS (SELECT 1 FROM payment_applications pa WHERE pa.gift_id = g2.id)
          OR g2.final_amount_qb_staged_payment_id IS NOT NULL
          OR g2.final_amount_stripe_charge_id IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM staged_payments sp
            WHERE sp.matched_gift_id = g2.id
               OR sp.created_gift_id = g2.id
               OR sp.group_reconciled_gift_id = g2.id
          )
          OR EXISTS (
            SELECT 1 FROM stripe_staged_charges sc
            WHERE sc.matched_gift_id = g2.id
               OR sc.created_gift_id = g2.id
          )
        )
    )
    -- ambiguity guard: exactly one phantom candidate on the pledge
    AND (
      SELECT count(*)
      FROM gifts_and_payments gc
      WHERE gc.opportunity_id = o.id
        AND gc.archived_at IS NULL
        AND gc.amount = o.awarded_amount
        AND NOT EXISTS (SELECT 1 FROM payment_applications pa WHERE pa.gift_id = gc.id)
        AND gc.final_amount_qb_staged_payment_id IS NULL
        AND gc.final_amount_stripe_charge_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM staged_payments sp
          WHERE sp.matched_gift_id = gc.id
             OR sp.created_gift_id = gc.id
             OR sp.group_reconciled_gift_id = gc.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM stripe_staged_charges sc
          WHERE sc.matched_gift_id = gc.id OR sc.created_gift_id = gc.id
        )
        AND gc.gift_being_matched_id IS NULL
        AND gc.overpay_of_gift_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM gifts_and_payments g3
          WHERE g3.gift_being_matched_id = gc.id OR g3.overpay_of_gift_id = gc.id
        )
    ) = 1;

  RAISE NOTICE '0102: archived % phantom award gift(s); remaining candidates = % (expect 0)',
    n_archived, n_remaining;
END $$;
