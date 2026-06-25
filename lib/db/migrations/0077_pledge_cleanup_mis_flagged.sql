-- 0077_pledge_cleanup_mis_flagged.sql
--
-- DATA-ONLY production cleanup of 44 opportunities/pledges that were wrongly
-- flagged as written pledges (written_pledge = true) and therefore pollute the
-- Pledges page (its filter is purely written_pledge = true). No schema or
-- app-code changes here (the friendly "Research needed" badge label ships as a
-- separate code change via Publish).
--
-- All 44 ids were cross-checked against PRODUCTION and given a per-record
-- decision (provenance: exports/flagged-pledges-evidence.csv and
-- exports/flagged-pledges-remaining.csv). The decisions collapse into:
--
--   A. Fully paid (15)  → clear the flag only. status stays 'cash_in',
--      stage stays 'complete', win_probability stays 1.0000 (fully paid is a
--      derivation fixed point; clearing written_pledge changes nothing derived).
--   B. Dormant/lost (3) → clear the flag only. status/stage/win_probability
--      unchanged (loss_type drives status; fixed point).
--   C. Unpaid (25)      → reopen as an active opportunity AND flag for research:
--      written_pledge=false, status='open', stage='verbal_confirmation',
--      win_probability=0.9000, plus one cleanup_queue item per row
--      (target_type='opportunity').
--   Gates Family $85k (1) → NO field change (stays status='pledge',
--      written_pledge=true); flag for research only (target_type='pledge'),
--      because $45,000 of $85,000 is still outstanding.
--
-- The explicit status/stage/win_probability values mirror deriveOppFields /
-- canonicalWinProbability (artifacts/api-server/src/lib/pledgeStage.ts). The
-- hand-applied SQL bypasses applyDerivedOppFields, so it sets the derived
-- fields itself; re-deriving via the app afterward is a fixed point (verified).
-- The 25 Group C rows all have paid=0, no loss_type, and NO grant_letter_url
-- (a top-of-file guard re-asserts this), so the flag will NOT re-latch.
--
-- The 5 "keep, no change" rows and the already-archived recdkOIzI6ZQKTH2D are
-- NEVER touched (the Gates row gets only its single cleanup_queue insert).
--
-- Net writes: written_pledge=false on 43 rows (A 15 + B 3 + C 25); the
-- status/stage/win_probability update on the 25 Group C rows; 26 cleanup_queue
-- inserts (25 opportunity + 1 pledge).
--
-- Idempotent: id-scoped + guarded UPDATEs (WHERE written_pledge = true) and
-- ON CONFLICT DO NOTHING cleanup_queue inserts. Re-running after a successful
-- apply is a no-op. Non-destructive: no DELETEs.
--
-- Applied by a human (the agent cannot write prod), AFTER Publish (so the
-- cleanup_queue table exists):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0077_pledge_cleanup_mis_flagged.sql
--
-- NOTE: no BEGIN/COMMIT here — psql -1 wraps the whole file in one transaction.

-- ──────────────────────────────────────────────────────────────────────────
-- Guard: reopening the 25 Group C rows as plain opportunities is only safe if
-- none of them would immediately re-latch written_pledge=true (a grant letter
-- while unpaid) or carry a loss/payment that contradicts "open". If any does,
-- STOP rather than silently produce a wrong status.
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM opportunities_and_pledges op
    WHERE op.id IN (
      'rec0tyHATW1ntJA2D','rec39bWJVTDMmjwJh','rec3b1aly76zyeTdB','rec7kG6cJS6SOdb36',
      'recBZEm5IiE1IVLxk','recDuRwwzbgvsdNX8','recJh2jKA518aKvJJ','recK7gM3V9LSyQtEW',
      'recKNFnTdqWP6PQjU','recKurWNUmaLKTPlS','recOPn9HqPXCh097M','recRSZv2pRjTTyXV9',
      'recRxJVXpdT5QXkul','recSsLaVJjroL8Geb','recTFwj85oZP5VpsM','recU3ZlMQlCvQCg3h',
      'recbibJ4IB42Hhj5l','recd7VQZgCFPH3rlt','recdatu1WvYvO8oVu','recdpCTCJZAxv8qIm',
      'rececEiHHbxiRwrZ4','reciUdH6HwyzTkpx8','recmIKHDe8gXWazKy','recpEld2qjbdbOD7W',
      'recuetGdqrbtuJo5A'
    )
    AND (op.grant_letter_url IS NOT NULL OR op.loss_type IS NOT NULL OR COALESCE(op.paid, 0) <> 0)
  ) THEN
    RAISE EXCEPTION
      '0077: a Group C row has a grant letter / loss_type / nonzero paid; aborting (reopening would derive the wrong status — needs human review)';
  END IF;
END $$;

-- Pre-state (for the operator).
DO $$
DECLARE n_before int; n_nr_before int;
BEGIN
  SELECT count(*) INTO n_before FROM opportunities_and_pledges WHERE written_pledge = true;
  SELECT count(*) INTO n_nr_before FROM cleanup_queue
    WHERE reason_code = 'needs_research' AND status = 'open';
  RAISE NOTICE '0077: written_pledge=true rows BEFORE = % | open needs_research items BEFORE = %', n_before, n_nr_before;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- A. Fully paid (15) → clear the flag only. status/stage/win_probability are a
--    derivation fixed point for fully-paid rows, so we touch only
--    written_pledge (+ updated_at). Guarded on written_pledge = true.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE opportunities_and_pledges
SET written_pledge = false, updated_at = now()
WHERE written_pledge = true
  AND id IN (
    'rec4XbW1UwjSGadHq','rec6xawrr24Wow3cn','recBUCBv816oLVcha','recCGCtAhiQWmJ8qu',
    'recGCXle5ZhCSdYbg','recHps5zYSSo1IKoO','recNiNwhw2c5LJTuq','recRvbMm19YncE3Lc',
    'recVh9o52xmTJ3mKA','recbulsRLbAKB2YpC','reccb1gbLB9gEzFWm','reck3ikZdklICf4ma',
    'recmuYoQ1aheant6K','recohEH4lZm5yixFm','recqFg4sHhrsj5rz6'
  );

-- ══════════════════════════════════════════════════════════════════════════
-- B. Dormant/lost (3) → clear the flag only. loss_type still drives status,
--    so status/stage/win_probability are unchanged. Guarded on
--    written_pledge = true.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE opportunities_and_pledges
SET written_pledge = false, updated_at = now()
WHERE written_pledge = true
  AND id IN (
    'recshi9Srdid53Ch8','rectHemay0VaaUCbv','recfh0YZ8e5Js1vv1'
  );

-- ══════════════════════════════════════════════════════════════════════════
-- C. Unpaid (25) → reopen as an active opportunity. Clear the flag and set the
--    derived fields explicitly (mirrors deriveOppFields: not won, not paid, no
--    loss ⇒ status='open'; stage='verbal_confirmation'; that stage's canonical
--    win_probability is 0.9000). Guarded on written_pledge = true.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE opportunities_and_pledges
SET written_pledge  = false,
    status          = 'open',
    stage           = 'verbal_confirmation',
    win_probability = 0.9000,
    updated_at      = now()
WHERE written_pledge = true
  AND id IN (
    'rec0tyHATW1ntJA2D','rec39bWJVTDMmjwJh','rec3b1aly76zyeTdB','rec7kG6cJS6SOdb36',
    'recBZEm5IiE1IVLxk','recDuRwwzbgvsdNX8','recJh2jKA518aKvJJ','recK7gM3V9LSyQtEW',
    'recKNFnTdqWP6PQjU','recKurWNUmaLKTPlS','recOPn9HqPXCh097M','recRSZv2pRjTTyXV9',
    'recRxJVXpdT5QXkul','recSsLaVJjroL8Geb','recTFwj85oZP5VpsM','recU3ZlMQlCvQCg3h',
    'recbibJ4IB42Hhj5l','recd7VQZgCFPH3rlt','recdatu1WvYvO8oVu','recdpCTCJZAxv8qIm',
    'rececEiHHbxiRwrZ4','reciUdH6HwyzTkpx8','recmIKHDe8gXWazKy','recpEld2qjbdbOD7W',
    'recuetGdqrbtuJo5A'
  );

-- ══════════════════════════════════════════════════════════════════════════
-- Cleanup-queue seeding. reason_code='needs_research', friendly badge label
-- "Research needed" ships in the frontend. id is deterministic
-- ('cleanup_nr_' || target_id) so re-runs map to the same row, and the natural
-- key (target_type, target_id, reason_code) conflict means an item a human has
-- already resolved/dismissed is NOT resurrected.
-- ══════════════════════════════════════════════════════════════════════════

-- C-queue: the 25 reopened opportunities (target_type='opportunity').
INSERT INTO cleanup_queue (
  id, target_type, target_id, reason_code, note, status, flagged_at, created_at, updated_at
)
SELECT
  'cleanup_nr_' || op.id,
  'opportunity',
  op.id,
  'needs_research',
  'Was wrongly flagged as a written pledge but has no payments, no grant letter, and only an imported allocation. Reopened as an active opportunity — research whether this is a live ask, a duplicate import, or should be closed (dormant/lost).',
  'open',
  now(), now(), now()
FROM opportunities_and_pledges op
WHERE op.id IN (
  'rec0tyHATW1ntJA2D','rec39bWJVTDMmjwJh','rec3b1aly76zyeTdB','rec7kG6cJS6SOdb36',
  'recBZEm5IiE1IVLxk','recDuRwwzbgvsdNX8','recJh2jKA518aKvJJ','recK7gM3V9LSyQtEW',
  'recKNFnTdqWP6PQjU','recKurWNUmaLKTPlS','recOPn9HqPXCh097M','recRSZv2pRjTTyXV9',
  'recRxJVXpdT5QXkul','recSsLaVJjroL8Geb','recTFwj85oZP5VpsM','recU3ZlMQlCvQCg3h',
  'recbibJ4IB42Hhj5l','recd7VQZgCFPH3rlt','recdatu1WvYvO8oVu','recdpCTCJZAxv8qIm',
  'rececEiHHbxiRwrZ4','reciUdH6HwyzTkpx8','recmIKHDe8gXWazKy','recpEld2qjbdbOD7W',
  'recuetGdqrbtuJo5A'
)
ON CONFLICT (target_type, target_id, reason_code) DO NOTHING;

-- Gates Family $85k pledge (rec3MTMlSE06qaL2L): kept as a pledge, NO field
-- change, but flagged for research (target_type='pledge') because $45,000 of
-- $85,000 is still outstanding.
INSERT INTO cleanup_queue (
  id, target_type, target_id, reason_code, note, status, flagged_at, created_at, updated_at
)
SELECT
  'cleanup_nr_' || op.id,
  'pledge',
  op.id,
  'needs_research',
  'Kept as a pledge: $40,000 of $85,000 received, $45,000 still outstanding. Confirm the remaining $45,000 is still expected; if not, close out the pledge.',
  'open',
  now(), now(), now()
FROM opportunities_and_pledges op
WHERE op.id = 'rec3MTMlSE06qaL2L'
ON CONFLICT (target_type, target_id, reason_code) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════
-- Post-state verification (verify by STATE, not clean exit).
-- ══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n_wp_true      int;  -- written_pledge=true rows remaining (whole table)
  n_groupc_ok    int;  -- Group C rows now open/verbal_confirmation/0.9000
  n_gates_pledge int;  -- Gates row still a pledge
  n_nr_open      int;  -- open needs_research cleanup items
BEGIN
  SELECT count(*) INTO n_wp_true
    FROM opportunities_and_pledges WHERE written_pledge = true;

  SELECT count(*) INTO n_groupc_ok
    FROM opportunities_and_pledges
   WHERE written_pledge = false AND status = 'open'
     AND stage = 'verbal_confirmation' AND win_probability = 0.9000
     AND id IN (
       'rec0tyHATW1ntJA2D','rec39bWJVTDMmjwJh','rec3b1aly76zyeTdB','rec7kG6cJS6SOdb36',
       'recBZEm5IiE1IVLxk','recDuRwwzbgvsdNX8','recJh2jKA518aKvJJ','recK7gM3V9LSyQtEW',
       'recKNFnTdqWP6PQjU','recKurWNUmaLKTPlS','recOPn9HqPXCh097M','recRSZv2pRjTTyXV9',
       'recRxJVXpdT5QXkul','recSsLaVJjroL8Geb','recTFwj85oZP5VpsM','recU3ZlMQlCvQCg3h',
       'recbibJ4IB42Hhj5l','recd7VQZgCFPH3rlt','recdatu1WvYvO8oVu','recdpCTCJZAxv8qIm',
       'rececEiHHbxiRwrZ4','reciUdH6HwyzTkpx8','recmIKHDe8gXWazKy','recpEld2qjbdbOD7W',
       'recuetGdqrbtuJo5A'
     );

  SELECT count(*) INTO n_gates_pledge
    FROM opportunities_and_pledges
   WHERE id = 'rec3MTMlSE06qaL2L' AND status = 'pledge' AND written_pledge = true;

  SELECT count(*) INTO n_nr_open
    FROM cleanup_queue WHERE reason_code = 'needs_research' AND status = 'open';

  RAISE NOTICE '0077 RESULT: written_pledge=true remaining = % | Group C reopened OK = % (expect 25) | Gates still pledge = % (expect 1) | open needs_research items = % (expect 26)',
    n_wp_true, n_groupc_ok, n_gates_pledge, n_nr_open;

  IF n_groupc_ok <> 25 THEN
    RAISE WARNING '0077: expected 25 Group C rows reopened, found % (re-run is a no-op once applied; investigate if this is the first apply)', n_groupc_ok;
  END IF;
  IF n_gates_pledge <> 1 THEN
    RAISE WARNING '0077: Gates pledge rec3MTMlSE06qaL2L not in expected state (status=pledge, written_pledge=true)';
  END IF;
END $$;
