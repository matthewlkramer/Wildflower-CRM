-- Migration 0060: Avi Nash Seed Challenge Grant — conditions met = 'partial'
--
-- The Avi Nash Seed Challenge Grant is a conditional (on-target) grant whose
-- conditions are only partially satisfied. Now that "conditions met" is a
-- tri-state field (see 0059), set this specific grant to 'partial'.
--
-- Idempotent: targets the row by its stable Airtable record id and only updates
-- when the value is not already 'partial'. Re-running is a no-op.
--
-- REQUIRES 0059 to have run first (the column must already be the
-- opportunity_conditions_met enum).
--
-- APPLY:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0060_avi_nash_seed_challenge_conditions_partial.sql

DO $$
DECLARE
  n_updated int;
BEGIN
  UPDATE opportunities_and_pledges
     SET conditions_met = 'partial',
         updated_at = now()
   WHERE id = 'recSmHuyBYL310qux'
     AND conditions_met IS DISTINCT FROM 'partial';
  GET DIAGNOSTICS n_updated = ROW_COUNT;
  RAISE NOTICE '0060: Avi Nash Seed Challenge Grant rows set to partial = % (0 = already partial / not present)', n_updated;
END $$;
