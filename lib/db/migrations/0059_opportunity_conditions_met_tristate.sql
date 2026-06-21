-- Migration 0059: Tri-state "conditions met" on opportunities & pledges
--
-- "Conditions met" was a boolean flag (yes/no). Real grants are often only
-- PARTIALLY satisfied, so the column becomes a three-value enum:
--   'no' | 'partial' | 'yes'
--
-- NON-DESTRUCTIVE conversion (preserves every existing value):
--   * existing FALSE / unset  → 'no'
--   * existing TRUE           → 'yes'
--   * 'partial' is new — only ever set deliberately (e.g. migration 0060).
--
-- The whole file is idempotent:
--   1. CREATE TYPE opportunity_conditions_met — guarded (CREATE TYPE has no
--      IF NOT EXISTS).
--   2. The column type swap runs ONLY while the column is still boolean, using
--      an explicit USING cast so no row loses its value. Re-running is a no-op
--      once the column is already the enum type.
--
-- ORDERING / APPLY:
--   The enum type + column type also reach a fresh schema via the normal
--   Publish (drizzle) diff. On a LIVE database, however, a boolean→enum type
--   change must be done deliberately with a USING cast (drizzle's interactive
--   push cannot generate one and may drop/recreate the column, losing data).
--   Therefore APPLY THIS FILE *BEFORE* Publish — afterwards the column already
--   matches the target type, so the Publish diff is an empty no-op.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0059_opportunity_conditions_met_tristate.sql
--
--   The file has no explicit BEGIN/COMMIT, so `-1` wraps it in a single
--   transaction (all-or-nothing) without conflicting.

-- 1. Enum type (guarded — CREATE TYPE has no IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'opportunity_conditions_met' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.opportunity_conditions_met AS ENUM ('no', 'partial', 'yes');
  END IF;
END $$;

-- 2. Convert the column in place, ONLY while it is still boolean. The USING
--    cast maps every existing value (true→'yes', false→'no'); nothing is lost.
DO $$
DECLARE
  coltype text;
BEGIN
  SELECT data_type INTO coltype
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'opportunities_and_pledges'
     AND column_name = 'conditions_met';

  IF coltype = 'boolean' THEN
    ALTER TABLE opportunities_and_pledges
      ALTER COLUMN conditions_met DROP DEFAULT;

    ALTER TABLE opportunities_and_pledges
      ALTER COLUMN conditions_met TYPE public.opportunity_conditions_met
      USING (CASE WHEN conditions_met
                  THEN 'yes'::public.opportunity_conditions_met
                  ELSE 'no'::public.opportunity_conditions_met
             END);

    ALTER TABLE opportunities_and_pledges
      ALTER COLUMN conditions_met SET DEFAULT 'no';

    ALTER TABLE opportunities_and_pledges
      ALTER COLUMN conditions_met SET NOT NULL;
  END IF;
END $$;

-- Report post-state for the operator (non-aborting).
DO $$
DECLARE
  n_no int;
  n_partial int;
  n_yes int;
BEGIN
  SELECT count(*) FILTER (WHERE conditions_met = 'no'),
         count(*) FILTER (WHERE conditions_met = 'partial'),
         count(*) FILTER (WHERE conditions_met = 'yes')
    INTO n_no, n_partial, n_yes
    FROM opportunities_and_pledges;
  RAISE NOTICE '0059: conditions_met no=%, partial=%, yes=%', n_no, n_partial, n_yes;
END $$;
