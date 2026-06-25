-- Migration 0076: Per-(signal type, review phase) email-intelligence review prompts
--
-- Splits the single global email-intelligence system prompt into a hidden,
-- hard-coded action-proposing core (NOT stored in the DB — it lives in code and
-- admins can neither see nor edit it) plus admin-editable per-(signal type,
-- review phase) REVIEW prompts. This file applies the additive schema + a
-- one-time DATA demotion of any legacy combined-prompt rows.
--
-- Schema (additive, idempotent):
--   1. enum  email_intel_signal_type
--            (linkedin_job_change | auto_responder_move | bounce |
--             signature_update | grant_opportunity | thank_you_acknowledgment)
--   2. enum  email_intel_review_phase (accuracy | suppression)
--   3. cols  email_intel_prompts.signal_type, .review_phase  (both NULLABLE)
--   4. index swap: drop the OLD global active/draft partial uniques
--                  (one active total) and add per-key composite partial uniques
--                  on (signal_type, review_phase) WHERE status = 'active'/'draft'.
--
-- Data (one-time, idempotent):
--   5. Demote every legacy combined-prompt row (signal_type IS NULL) that is
--      still 'active' or 'draft' to 'archived'. Under the new model the global
--      active/draft row is meaningless (the pipeline now resolves a prompt per
--      review key), and a null-keyed row can never occupy a per-key slot, so it
--      is retained as history only. No prompt text is lost.
--
-- WHY A HAND-APPLIED FILE: the agent cannot write to prod, and the legacy-row
-- demotion (step 5) is a DATA change Publish never performs. The schema steps
-- (1-4) are included so the file is self-contained and safe to run whether or
-- not the Publish schema diff has already landed them.
--
-- SAFETY / IDEMPOTENCY:
--   * Enums guarded by pg_type checks; columns use ADD COLUMN IF NOT EXISTS;
--     indexes use DROP INDEX IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS.
--   * The demotion is naturally idempotent (a second run matches zero rows once
--     all legacy rows are archived). Touches only legacy null-keyed rows.
--   * Drops no data — only re-labels legacy active/draft rows to archived.
--
-- Apply with psql -1 (wraps the whole file in ONE transaction; do NOT add a
-- top-level BEGIN/COMMIT here or it nests and warns):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0076_email_intel_review_prompts.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0076_email_intel_review_prompts.sql   (prod)

-- 1. enum email_intel_signal_type -------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'email_intel_signal_type') THEN
    CREATE TYPE email_intel_signal_type AS ENUM (
      'linkedin_job_change',
      'auto_responder_move',
      'bounce',
      'signature_update',
      'grant_opportunity',
      'thank_you_acknowledgment'
    );
  END IF;
END
$$;

-- 2. enum email_intel_review_phase ------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'email_intel_review_phase') THEN
    CREATE TYPE email_intel_review_phase AS ENUM ('accuracy', 'suppression');
  END IF;
END
$$;

-- 3. nullable key columns ----------------------------------------------------
ALTER TABLE email_intel_prompts
  ADD COLUMN IF NOT EXISTS signal_type  email_intel_signal_type,
  ADD COLUMN IF NOT EXISTS review_phase email_intel_review_phase;

-- 4. index swap: global uniques -> per-key composite uniques -----------------
DROP INDEX IF EXISTS email_intel_prompts_active_uq;
DROP INDEX IF EXISTS email_intel_prompts_draft_uq;

CREATE UNIQUE INDEX IF NOT EXISTS email_intel_prompts_active_key_uq
  ON email_intel_prompts (signal_type, review_phase)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS email_intel_prompts_draft_key_uq
  ON email_intel_prompts (signal_type, review_phase)
  WHERE status = 'draft';

-- 5. demote legacy combined-prompt rows to archived (DATA) -------------------
UPDATE email_intel_prompts
   SET status = 'archived', updated_at = now()
 WHERE signal_type IS NULL
   AND status IN ('active', 'draft');

-- Verification:
--   SELECT unnest(enum_range(NULL::email_intel_signal_type));
--   -- Expect: linkedin_job_change, auto_responder_move, bounce,
--   --   signature_update, grant_opportunity, thank_you_acknowledgment
--
--   SELECT unnest(enum_range(NULL::email_intel_review_phase));
--   -- Expect: accuracy, suppression
--
--   SELECT status, count(*)
--     FROM email_intel_prompts
--    WHERE signal_type IS NULL
--    GROUP BY status;
--   -- Expect: no 'active' or 'draft' rows remain (only 'archived', if any).
