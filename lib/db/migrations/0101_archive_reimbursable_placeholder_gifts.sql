-- Migration 0101: archive placeholder "award-amount" gifts on reimbursable
--                 pledges, then re-derive the affected pledges.
--
-- WHY:
--   Reimbursable grants (a pledge whose pledge_allocations carry
--   conditional = 'reimbursable') are PLEDGES: the funder reimburses real
--   expenses over time, so each real QuickBooks / Stripe check should be booked
--   as its own 1:1 gift payment (see .agents/memory/reimbursable-grant-payment-model.md).
--   Historically some of these pledges were booked with a single placeholder
--   gift for the FULL award amount instead of the individual reimbursement
--   checks. That placeholder lump is not real money — it has no QuickBooks /
--   Stripe / Donorbox evidence behind it — yet it:
--     * inflates the pledge's derived paid_amount (SUM of linked gifts) so the
--       pledge reads fully paid (status 'cash_in') when no cash has landed, and
--     * carries a phantom QuickBooks tie state (quickbooks_tie_status = 'missing')
--       because there is no QB transaction to tie the award lump to.
--
--   This file ARCHIVES (soft-delete, never hard-delete — invariant #6) those
--   placeholder award gifts, then re-derives the affected pledges so their
--   paid_amount excludes the archived lump and status re-derives via the same
--   rules the app's deriveOppFields uses. Real reimbursement checks (booked as
--   1:1 payment gifts against QB/Stripe evidence) are left untouched.
--
-- WHAT THIS FILE DOES (DATA-only, idempotent, non-destructive):
--   1. Identify the placeholder award gifts to archive. Detection is
--      DELIBERATELY CONSERVATIVE — a gift qualifies only when ALL hold:
--        a. it is still active (archived_at IS NULL);
--        b. its opportunity carries at least one reimbursable pledge_allocation
--           (conditional = 'reimbursable');
--        c. the pledge has a positive awarded_amount and the gift.amount EXACTLY
--           equals that award (the "award lump" signature);
--        d. it is the SOLE active gift on that pledge (a single header gift, not
--           one of several real reimbursement checks);
--        e. it has NO settlement evidence anywhere — no payment_applications
--           ledger row (QB / Stripe / Donorbox), no legacy final-amount pointer
--           (final_amount_qb_staged_payment_id / final_amount_stripe_charge_id),
--           no staged_payments link (matched / created / group_reconciled), and
--           no stripe_staged_charges link (matched / created);
--        f. it is not entangled in a match / overpay relationship (it neither
--           points at another gift via gift_being_matched_id / overpay_of_gift_id
--           nor is pointed at by one).
--   2. Archive each such gift (archived_at = now()). Nothing is hard-deleted.
--   3. Re-derive every affected pledge by mirroring deriveOppFields /
--      applyDerivedOppFields (a raw-SQL data change does NOT run the app's
--      server-side derivation — see .agents/memory/pledge-status-rederivation.md):
--        * paid           = SUM(amount) of the pledge's NON-archived gifts (0 once
--                           the sole placeholder is archived, unless real checks
--                           exist);
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
--   * Re-running is a no-op: an already-archived placeholder has archived_at set,
--     so guard (a) excludes it, the archive UPDATE touches 0 rows, and the
--     re-derivation runs over an empty affected set.
--   * Every guard is an equality / NOT EXISTS over current state, so the result
--     is stable across runs.
--   * SPOT-VERIFY FIRST. Run section 0 (the read-only preview) against
--     $PROD_DATABASE_URL and eyeball the candidates against known reimbursable
--     grantors (PELSB / DEED / Early Milestones) BEFORE applying sections 1-3.
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0101_archive_reimbursable_placeholder_gifts.sql
--
-- Run with `-1` (psql wraps the whole file in ONE transaction). Do NOT add an
-- internal BEGIN/COMMIT — `-1` already provides the single-transaction guarantee.

-- ─── 1. Collect the placeholder award gifts to archive ─────────────────────
-- ON COMMIT DROP so the temp table lives only for this single `-1` transaction.
CREATE TEMP TABLE _reimb_placeholder_gifts ON COMMIT DROP AS
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
  -- (d) the sole active gift on this pledge
  AND (
    SELECT count(*) FROM gifts_and_payments g2
    WHERE g2.opportunity_id = o.id
      AND g2.archived_at IS NULL
  ) = 1
  -- (e) no settlement evidence of any kind
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
  -- (f) not entangled in a match / overpay relationship
  AND g.gift_being_matched_id IS NULL
  AND g.overpay_of_gift_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM gifts_and_payments g3
    WHERE g3.gift_being_matched_id = g.id
       OR g3.overpay_of_gift_id = g.id
  );

-- ─── 0. READ-ONLY PREVIEW (spot-verify before applying) ────────────────────
-- Emits one NOTICE per candidate so an operator can eyeball them (PELSB / DEED /
-- Early Milestones, etc.) before the archive UPDATE below runs in the same
-- transaction. Purely informational — it writes nothing.
DO $$
DECLARE
  r record;
  n int;
BEGIN
  SELECT count(*) INTO n FROM _reimb_placeholder_gifts;
  RAISE NOTICE '0101 PREVIEW: % placeholder award gift(s) will be archived', n;
  FOR r IN
    SELECT t.gift_id,
           g.amount,
           o.id  AS opp_id,
           o.name AS opp_name,
           COALESCE(org.name, ppl.full_name, hh.name, '(no donor)') AS donor
    FROM _reimb_placeholder_gifts t
    JOIN gifts_and_payments g ON g.id = t.gift_id
    JOIN opportunities_and_pledges o ON o.id = t.opportunity_id
    LEFT JOIN organizations org ON org.id = o.organization_id
    LEFT JOIN people ppl ON ppl.id = o.individual_giver_person_id
    LEFT JOIN households hh ON hh.id = o.household_id
    ORDER BY donor, o.name
  LOOP
    RAISE NOTICE '  gift % | amount % | pledge % (%) | donor %',
      r.gift_id, r.amount, r.opp_id, r.opp_name, r.donor;
  END LOOP;
END $$;

-- ─── 2. Archive the placeholder gifts (soft-delete only) ───────────────────
UPDATE gifts_and_payments g
SET archived_at = now(),
    updated_at = now()
FROM _reimb_placeholder_gifts t
WHERE g.id = t.gift_id
  AND g.archived_at IS NULL;

-- ─── 3. Re-derive the affected pledges (mirror deriveOppFields) ────────────
WITH affected AS (
  SELECT DISTINCT opportunity_id AS id
  FROM _reimb_placeholder_gifts
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
  SELECT count(*) INTO n_archived FROM _reimb_placeholder_gifts;

  -- After the archive this should read 0: no active placeholder award gift on a
  -- reimbursable, single-gift pledge with no settlement evidence remains.
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
    AND (
      SELECT count(*) FROM gifts_and_payments g2
      WHERE g2.opportunity_id = o.id AND g2.archived_at IS NULL
    ) = 1
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
    );

  RAISE NOTICE '0101: archived % placeholder award gift(s); remaining candidates = % (expect 0)',
    n_archived, n_remaining;
END $$;
