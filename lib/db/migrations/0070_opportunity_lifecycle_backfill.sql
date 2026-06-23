-- Migration 0070: Backfill the redesigned opportunity/pledge lifecycle
--
-- DATA-ONLY backfill for the lifecycle redesign that separated the cultivation
-- `stage` (a pure funnel + terminal `complete`) from the OUTCOME, renamed
-- `was_pledge` -> `written_pledge`, added the persisted derived `paid` rollup,
-- and renamed the gift link `payment_on_pledge_id` -> `opportunity_id`. The
-- additive schema (new columns, renamed columns, retained-but-deprecated enum
-- values) ships via the normal Publish flow; THIS file only re-derives the
-- per-row values to match the new derivation in
-- `artifacts/api-server/src/lib/pledgeStage.ts` (deriveOppFields +
-- canonicalWinProbability). It is the SQL mirror of that pure function.
--
-- ORDERING: requires the schema diff for this redesign to have been applied
-- first (the `paid` / `written_pledge` columns, the renamed gift
-- `opportunity_id` column, and the `complete` stage enum value must already
-- exist). Run AFTER Publish.
--
-- What it recomputes, in the same order the app derives them:
--   1. paid            = SUM(amount) of linked NON-archived gifts (opportunity_id),
--                        0 when none. Archived gifts are excluded so an archived
--                        payment can't keep a row derived as cash_in.
--   2. written_pledge  = sticky-true latch: stays true if already true, and
--                        flips true on a grant letter OR a legacy commitment
--                        stage (conditional_commitment / written_commitment /
--                        cash_in). NEVER auto-cleared.
--   3. status          = FULLY CALCULATED (cash_in is PAYMENT-DRIVEN only):
--                          loss_type set (dormant|lost)            -> loss_type
--                          else fully paid (paid>=awarded>0)       -> 'cash_in'
--                          else written_pledge                     -> 'pledge'
--                          else                                    -> 'open'
--                        (Stored value 'pledge'; UI label "Waiting for payment".)
--   4. stage           = pure funnel: a WON row (status pledge|cash_in) reads
--                        'complete'; a stale 'complete' on a non-won row is
--                        reverted to 'verbal_confirmation' (win-reversal safety);
--                        otherwise the funnel stage is preserved (lost/dormant
--                        KEEP their cultivation stage).
--   5. win_probability = canonical default for (status, stage, conditional):
--                          lost/dormant            -> 0.0000
--                          cash_in                 -> 1.0000
--                          pledge (unpaid written) -> 0.9000, or 0.7500 when the
--                                                     conditional kind is one of
--                                                     the genuinely-uncertain
--                                                     conditional_* values
--                          open                    -> by funnel stage
--                          (uncomputable)          -> existing value preserved
--
-- IDEMPOTENT / RE-RUNNABLE: a single set-based UPDATE whose WHERE clause only
-- touches rows whose derived values actually differ, so re-running reports 0
-- rows affected. Forward-safe to run after live writes have begun — it computes
-- exactly what the app's applyDerivedOppFields would compute for each row.
--
-- Apply with psql -1 (wraps the file in ONE transaction; no top-level
-- BEGIN/COMMIT here):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0070_opportunity_lifecycle_backfill.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0070_opportunity_lifecycle_backfill.sql   (prod)

WITH paid_rollup AS (
  SELECT o.id,
         COALESCE(
           SUM(g.amount) FILTER (WHERE g.archived_at IS NULL),
           0
         )::numeric(14,2) AS new_paid
    FROM opportunities_and_pledges o
    LEFT JOIN gifts_and_payments g ON g.opportunity_id = o.id
   GROUP BY o.id
),
written AS (
  SELECT o.id,
         pr.new_paid,
         (
           o.written_pledge
           OR o.grant_letter_url IS NOT NULL
           OR o.stage IN ('conditional_commitment', 'written_commitment', 'cash_in')
         ) AS new_written_pledge,
         (
           o.awarded_amount IS NOT NULL
           AND o.awarded_amount > 0
           AND pr.new_paid >= o.awarded_amount
         ) AS fully_paid
    FROM opportunities_and_pledges o
    JOIN paid_rollup pr ON pr.id = o.id
),
status_calc AS (
  -- cash_in is PAYMENT-DRIVEN: status='cash_in' only when actually paid
  -- (paid>=awarded>0). A legacy stage='cash_in' row LATCHES written_pledge (see
  -- the `written` CTE above) but does NOT force status='cash_in' — with no full
  -- linked payment it resolves to 'pledge' (the underpaid cash-in rows the
  -- redesign is meant to surface), never a sticky cash_in. This mirrors
  -- deriveOppFields exactly and keeps the backfill a true single-pass fixed
  -- point (idempotent): a win sets stage='complete', which would otherwise
  -- destroy a legacy stage='cash_in' signal on a second pass.
  SELECT w.id, w.new_paid, w.new_written_pledge,
         CASE
           WHEN o.loss_type IN ('dormant', 'lost') THEN o.loss_type::text
           WHEN w.fully_paid THEN 'cash_in'
           WHEN w.new_written_pledge THEN 'pledge'
           ELSE 'open'
         END AS new_status
    FROM written w
    JOIN opportunities_and_pledges o ON o.id = w.id
),
stage_calc AS (
  SELECT s.id, s.new_paid, s.new_written_pledge, s.new_status,
         CASE
           WHEN s.new_status IN ('pledge', 'cash_in') THEN 'complete'
           WHEN o.stage = 'complete' THEN 'verbal_confirmation'
           ELSE o.stage::text
         END AS new_stage
    FROM status_calc s
    JOIN opportunities_and_pledges o ON o.id = s.id
),
final AS (
  SELECT c.id, c.new_paid, c.new_written_pledge, c.new_status, c.new_stage,
         CASE
           WHEN c.new_status IN ('lost', 'dormant') THEN 0.0000
           WHEN c.new_status = 'cash_in' THEN 1.0000
           WHEN c.new_status = 'pledge' THEN
             CASE
               WHEN o.conditional IN (
                 'conditional_unspecified',
                 'conditional_on_funder_determination',
                 'conditional_on_target'
               ) THEN 0.7500
               ELSE 0.9000
             END
           WHEN c.new_stage = 'cold_lead' THEN 0.0000
           WHEN c.new_stage = 'warm_lead' THEN 0.0500
           WHEN c.new_stage = 'in_conversation' THEN 0.2000
           WHEN c.new_stage = 'convince' THEN 0.4000
           WHEN c.new_stage = 'probable_renewal' THEN 0.7500
           WHEN c.new_stage = 'verbal_confirmation' THEN 0.9000
           WHEN c.new_stage = 'conditional_commitment' THEN 0.7500
           WHEN c.new_stage = 'written_commitment' THEN 0.9000
           WHEN c.new_stage = 'cash_in' THEN 1.0000
           WHEN c.new_stage = 'complete' THEN 1.0000
           ELSE o.win_probability
         END::numeric(5,4) AS new_win_probability
    FROM stage_calc c
    JOIN opportunities_and_pledges o ON o.id = c.id
)
UPDATE opportunities_and_pledges o
   SET paid            = f.new_paid,
       written_pledge  = f.new_written_pledge,
       status          = f.new_status::opportunity_status,
       stage           = f.new_stage::opportunity_stage,
       win_probability = f.new_win_probability,
       updated_at      = NOW()
  FROM final f
 WHERE o.id = f.id
   AND (
        o.paid            IS DISTINCT FROM f.new_paid
     OR o.written_pledge  IS DISTINCT FROM f.new_written_pledge
     OR o.status::text    IS DISTINCT FROM f.new_status
     OR o.stage::text     IS DISTINCT FROM f.new_stage
     OR o.win_probability IS DISTINCT FROM f.new_win_probability
   );

-- Verification (run after apply; all should be self-consistent):
--
--   -- 1. paid matches the live non-archived linked-gift sum for every row.
--   SELECT count(*) AS paid_mismatch
--     FROM opportunities_and_pledges o
--     LEFT JOIN (
--       SELECT opportunity_id, COALESCE(SUM(amount), 0)::numeric(14,2) AS s
--         FROM gifts_and_payments
--        WHERE archived_at IS NULL AND opportunity_id IS NOT NULL
--        GROUP BY opportunity_id
--     ) g ON g.opportunity_id = o.id
--    WHERE o.paid IS DISTINCT FROM COALESCE(g.s, 0);
--   -- Expect 0.
--
--   -- 2. No non-won row is left showing the terminal funnel stage.
--   SELECT count(*) AS stale_complete
--     FROM opportunities_and_pledges
--    WHERE stage = 'complete' AND status NOT IN ('pledge', 'cash_in');
--   -- Expect 0.
--
--   -- 3. Every won row reads 'complete'.
--   SELECT count(*) AS won_not_complete
--     FROM opportunities_and_pledges
--    WHERE status IN ('pledge', 'cash_in') AND stage <> 'complete';
--   -- Expect 0.
--
--   -- 4. loss_type override always wins.
--   SELECT count(*) AS loss_mismatch
--     FROM opportunities_and_pledges
--    WHERE loss_type IN ('dormant', 'lost') AND status::text <> loss_type::text;
--   -- Expect 0.
--
--   -- 5. Re-running this file reports 0 rows updated (idempotent).
