-- Migration 0059: Seed the cleanup queue with conditional-commitment pledges
--
-- The cleanup queue (cleanup_queue, added via the normal Drizzle schema diff /
-- Publish) lists records flagged for MANUAL data cleanup. This file seeds it
-- with every opportunity/pledge currently sitting at the
-- `conditional_commitment` stage.
--
-- WHY: "conditional_commitment" conflates two separate facts — that a
-- commitment exists, and that it carries conditions. The intended cleanup (done
-- by a human, per record) is to move the conditional aspect into the dedicated
-- `conditions` text field and re-stage the row to a non-conditional commitment
-- stage. This migration only QUEUES those records for review; it does NOT touch
-- the opportunity stage, conditions, or the conditional_commitment enum value
-- (all explicitly out of scope).
--
-- TARGET MODEL:
--   target_type = 'pledge'                       (these are pledges; the UI
--                                                  links to /pledges/:id)
--   target_id   = opportunities_and_pledges.id
--   reason_code = 'conditional_commitment_stage' (idempotency category)
--   id          = 'cleanup_cc_' || op.id         (deterministic, re-run-safe)
--
-- NON-DESTRUCTIVE + IDEMPOTENT:
--   - Only INSERTs cleanup_queue rows; never modifies the targeted records.
--   - ON CONFLICT (target_type, target_id, reason_code) DO NOTHING, so a
--     re-run is a no-op and a row a human has already resolved/dismissed is
--     NOT resurrected (the conflict is on the natural key, not the id).
--   - Depends on the cleanup_queue table existing (ships via Publish / the
--     Drizzle schema diff). Run AFTER Publish.
--
-- APPLY (dev already applied by the agent; prod is human-run):
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0059_cleanup_queue_conditional_pledges.sql

-- Pre-state (for the operator).
DO $$
DECLARE n_before int;
BEGIN
  SELECT count(*) INTO n_before
    FROM cleanup_queue WHERE reason_code = 'conditional_commitment_stage';
  RAISE NOTICE '0059: conditional_commitment cleanup items BEFORE = %', n_before;
END $$;

INSERT INTO cleanup_queue (
  id, target_type, target_id, reason_code, note, status, flagged_at, created_at, updated_at
)
SELECT
  'cleanup_cc_' || op.id,
  'pledge',
  op.id,
  'conditional_commitment_stage',
  'Pledge is at the "conditional commitment" stage. Move the conditional details into the Conditions field and re-stage to a non-conditional commitment stage.',
  'open',
  now(),
  now(),
  now()
FROM opportunities_and_pledges op
WHERE op.stage = 'conditional_commitment'
ON CONFLICT (target_type, target_id, reason_code) DO NOTHING;

-- Post-state (for the operator).
DO $$
DECLARE
  n_after int;
  n_stage int;
BEGIN
  SELECT count(*) INTO n_after
    FROM cleanup_queue WHERE reason_code = 'conditional_commitment_stage';
  SELECT count(*) INTO n_stage
    FROM opportunities_and_pledges WHERE stage = 'conditional_commitment';
  RAISE NOTICE '0059: conditional_commitment cleanup items AFTER = % (conditional_commitment pledges = %)', n_after, n_stage;
END $$;
