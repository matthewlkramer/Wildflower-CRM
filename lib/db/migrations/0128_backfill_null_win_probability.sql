-- 0128: Backfill NULL win_probability on opportunities_and_pledges.
--
-- Why: the analytics rollups (dashboard weighted pipeline, projections, FY
-- report) no longer COALESCE around a NULL win_probability — every row is
-- expected to carry a weight. Historically, rows created before the derivation
-- stamped weights (or healed out-of-band) could carry NULL, which the old
-- rollups silently counted at 100% (open) or 90% (pledge). This backfill
-- stamps the canonical weight the application derivation
-- (canonicalWinProbability in artifacts/api-server/src/lib/pledgeStage.ts)
-- would compute, using the row's *derived* status:
--
--   loss_type dormant/lost                       -> 0.0000
--   fully paid (awarded > 0 AND paid >= awarded) -> 1.0000  (cash_in)
--   written pledge (flag or grant letter)        -> 0.9000, 0.7500 if any
--                                                   allocation is conditional
--   otherwise (open)                             -> by stage weight;
--                                                   no stage -> 0.0000
--
-- Idempotent: only touches rows WHERE win_probability IS NULL; a second run
-- matches zero rows. Ordering: safe to run before or after the code Publish
-- (the new code also self-heals NULLs row-by-row on next touch); run it right
-- after Publish so the weighted analytics are correct immediately.
--
-- NOTE: no BEGIN/COMMIT here — apply with `psql -1` (single transaction).

UPDATE opportunities_and_pledges o
SET win_probability = sub.wp,
    updated_at = NOW()
FROM (
  SELECT o2.id,
    CASE
      -- Terminal user-set loss states.
      WHEN o2.loss_type IN ('dormant', 'lost') THEN 0.0000
      -- Fully paid => derived status cash_in.
      WHEN COALESCE(o2.awarded_amount, 0) > 0
           AND COALESCE(p.paid, 0) >= o2.awarded_amount THEN 1.0000
      -- Unpaid written pledge (sticky flag, or a grant letter on a
      -- not-fully-paid row — same rule as deriveOppFields).
      WHEN COALESCE(o2.written_pledge, false)
           OR o2.grant_letter_url IS NOT NULL THEN
        CASE WHEN EXISTS (
          SELECT 1
          FROM pledge_allocations pa
          WHERE pa.pledge_or_opportunity_id = o2.id
            AND pa.conditional IN (
              'conditional_unspecified',
              'conditional_on_funder_determination',
              'conditional_on_target'
            )
        ) THEN 0.7500 ELSE 0.9000 END
      -- Open: weight by funnel stage (mirror of STAGE_WIN_PROBABILITY).
      ELSE CASE o2.stage::text
        WHEN 'cold_lead'              THEN 0.0000
        WHEN 'warm_lead'              THEN 0.0500
        WHEN 'in_conversation'        THEN 0.2000
        WHEN 'convince'               THEN 0.4000
        WHEN 'probable_renewal'       THEN 0.7500
        WHEN 'verbal_confirmation'    THEN 0.9000
        WHEN 'conditional_commitment' THEN 0.7500  -- legacy stage
        WHEN 'written_commitment'     THEN 0.9000  -- legacy stage
        WHEN 'cash_in'                THEN 1.0000
        WHEN 'complete'               THEN 1.0000
        -- No stage: an unstaged ask carries no funnel signal — cold-lead 0,
        -- never NULL (the old analytics fallback counted these at 100%).
        ELSE 0.0000
      END
    END AS wp
  FROM opportunities_and_pledges o2
  LEFT JOIN LATERAL (
    -- Paid rollup mirrors applyDerivedOppFields: non-archived gifts only.
    SELECT SUM(g.amount) AS paid
    FROM gifts_and_payments g
    WHERE g.opportunity_id = o2.id
      AND g.archived_at IS NULL
  ) p ON true
  WHERE o2.win_probability IS NULL
) sub
WHERE o.id = sub.id
  AND o.win_probability IS NULL;

-- Verification (expect 0):
--   SELECT count(*) FROM opportunities_and_pledges WHERE win_probability IS NULL;
