-- 0121 — Remap legacy funnel stages to verbal_confirmation
--
-- Context: the app no longer writes the three legacy commitment/outcome stage
-- values (conditional_commitment, written_commitment, cash_in) — the
-- commitment signal lives on the sticky written_pledge flag and the fully
-- calculated status. 10 prod opportunities (4 conditional_commitment,
-- 5 written_commitment, 1 cash_in) still sit on those values from the Copper
-- import era. This remaps them to verbal_confirmation, the nearest modern
-- pre-close funnel position, so every row uses the modern funnel.
--
--     psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0121_remap_legacy_stage_values.sql
--
-- Safety: idempotent — the WHERE clause only matches rows still on a legacy
-- stage, so a second run touches 0 rows. Derivation-neutral:
--   - status never reads stage (deriveOppFields: loss_type > fully-paid >
--     written_pledge > open) — all 10 prod rows are closed via loss_type
--     (lost/dormant), so status is pinned regardless of stage;
--   - written_pledge is sticky and legacy stages no longer latch it, so the
--     flag is untouched;
--   - win_probability is left as stored (closed rows canonically weight
--     0.0000 by status, and the projection tile weights closed rows 0 by
--     status, not by the stored stage weight);
--   - no money/allocation rows are touched, so all totals are unchanged.
-- The legacy values stay in the opportunity_stage pg enum (dropping enum
-- values requires a type rebuild; not worth it once zero rows use them).

UPDATE opportunities_and_pledges
SET stage = 'verbal_confirmation',
    updated_at = now()
WHERE stage IN ('conditional_commitment', 'written_commitment', 'cash_in');

-- Verification (expected: first query returns 0; second shows the 10 rows on
-- verbal_confirmation with status/written_pledge exactly as before the run):
--   SELECT count(*) FROM opportunities_and_pledges
--    WHERE stage IN ('conditional_commitment', 'written_commitment', 'cash_in');
--   SELECT id, name, stage, status, loss_type, written_pledge
--     FROM opportunities_and_pledges
--    WHERE id IN ('recTn2RJgppIsjgDv','recfh0YZ8e5Js1vv1','recshi9Srdid53Ch8',
--                 'recx2pj8EAY25kHNY','rec2YHolVH3pXiqIU','rec8jkTO0UGC6LmiH',
--                 'recYZ3qlDtZ0W9G6z','recbYxTAUssWy1e5g','recfCES9q23SnanDc',
--                 'rectHemay0VaaUCbv')
--    ORDER BY id;
