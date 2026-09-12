-- 0246: Replace the legacy verbose proposal JSON with one durable brief.
--
-- Safe to re-run. This preserves the exact legacy implementationBrief value
-- for every ready proposal, and refuses to drop legacy data if any ready row
-- would lose its handoff brief.
--
-- Human-run only (from the repository root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0246_app_feedback_implementation_brief.sql
--
-- Do not add BEGIN/COMMIT: psql -1 owns the transaction.

ALTER TABLE app_feedback_proposals
  ADD COLUMN IF NOT EXISTS implementation_brief text;

DO $$
DECLARE
  v_has_legacy_proposal boolean;
  v_ready_missing_brief integer;
  v_ready_mismatched_copy integer;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'app_feedback_proposals'
       AND column_name = 'proposal'
  ) INTO v_has_legacy_proposal;

  IF v_has_legacy_proposal THEN
    -- Do not overwrite a prior copied value: a mismatch is evidence of an
    -- unsafe partial/manual migration and must abort before the legacy drop.
    EXECUTE $sql$
      UPDATE app_feedback_proposals
         SET implementation_brief = proposal ->> 'implementationBrief'
       WHERE implementation_brief IS NULL
         AND proposal IS NOT NULL
    $sql$;

    EXECUTE $sql$
      SELECT count(*)::integer
        FROM app_feedback_proposals
       WHERE generation_status = 'ready'
         AND proposal IS NOT NULL
         AND jsonb_typeof(proposal -> 'implementationBrief') = 'string'
         AND btrim(proposal ->> 'implementationBrief') <> ''
         AND implementation_brief IS DISTINCT FROM proposal ->> 'implementationBrief'
    $sql$ INTO v_ready_mismatched_copy;

    IF v_ready_mismatched_copy <> 0 THEN
      RAISE EXCEPTION
        '0246 migration blocked: % ready proposal brief copies differ from legacy proposal data',
        v_ready_mismatched_copy;
    END IF;
  END IF;

  SELECT count(*)::integer
    INTO v_ready_missing_brief
    FROM app_feedback_proposals
   WHERE generation_status = 'ready'
     AND (implementation_brief IS NULL OR btrim(implementation_brief) = '');

  IF v_ready_missing_brief <> 0 THEN
    RAISE EXCEPTION
      '0246 migration blocked: % ready proposals have no non-empty implementation brief',
      v_ready_missing_brief;
  END IF;
END $$;

ALTER TABLE app_feedback_proposals
  DROP COLUMN IF EXISTS proposal;