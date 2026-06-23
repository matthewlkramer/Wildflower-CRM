-- Migration 0069: Correct two Annie Kuthart gift allocations to Tierra Indígena
--
-- DATA CORRECTION (no schema change). Two of Annie Kuthart's recurring $52.07
-- online donations to her monthly Tierra Indígena Montessori series have a BLANK
-- receiving entity on their single gift allocation. Every other month in the
-- series is already coded `tierra_indigena`, and the matching Stripe charge memo
-- on each ("recurring donation to Tierra Indígena Montessori", same donor / date
-- / amount) confirms the attribution. Set both to `tierra_indigena`.
--
--   Gift recGp8sWhhfkr1Tj1 -> allocation synth-ga-recGp8sWhhfkr1Tj1 ($52.07, 2022-09-20)
--   Gift recBZ2bNQVuaXSa1t -> allocation synth-ga-recBZ2bNQVuaXSa1t ($52.07, 2023-03-20)
--
-- WHY A SINGLE-COLUMN UPDATE IS SUFFICIENT (no coding re-derivation): the two
-- blank allocations were compared column-for-column against Annie's already-correct
-- Tierra Indígena sibling allocations. They are identical except for `entity_id`:
-- same `sub_amount` (52.07), same `grant_year` (fy2023), `restriction_type` =
-- `unclear`, and every derived revenue-coding column (`object_code`,
-- `revenue_location`, `revenue_class`, `coding_flags`, and all `*_override`s) is
-- NULL on both the blank rows AND the correct siblings. The parent gifts'
-- `quickbooks_tie_status` is `missing` on every row in the series (none are
-- off-books / designated-to-school). So setting `entity_id = 'tierra_indigena'`
-- makes each row identical to its correct siblings -- no revenue-coding or QB-tie
-- recomputation is required, and none of the derived columns would diverge from
-- how the app codes the existing TI siblings.
--
-- IDEMPOTENT / RE-RUNNABLE: the UPDATE is guarded so it only ever touches rows
-- that are still blank (`entity_id IS NULL`) and whose `gift_id` matches the
-- expected parent. A re-run reports 0 rows affected. No other gift's entity is
-- touched.
--
-- Apply with psql -1 (wraps the file in ONE transaction; no top-level
-- BEGIN/COMMIT here):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0069_annie_kuthart_tierra_indigena.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0069_annie_kuthart_tierra_indigena.sql   (prod)

UPDATE gift_allocations
   SET entity_id = 'tierra_indigena',
       updated_at = now()
 WHERE id IN ('synth-ga-recGp8sWhhfkr1Tj1', 'synth-ga-recBZ2bNQVuaXSa1t')
   AND gift_id IN ('recGp8sWhhfkr1Tj1', 'recBZ2bNQVuaXSa1t')
   AND entity_id IS NULL;

-- Verification (confirm by state, not by a clean exit). Expect both rows to read
-- `tierra_indigena`:
--   SELECT id, gift_id, entity_id
--     FROM gift_allocations
--    WHERE id IN ('synth-ga-recGp8sWhhfkr1Tj1', 'synth-ga-recBZ2bNQVuaXSa1t');
--   -- Expect: both entity_id = tierra_indigena.
