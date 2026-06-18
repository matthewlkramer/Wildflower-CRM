-- Migration 0045: earned income / fees-for-service recognised by the free-text
-- MEMO / NOTE (not just the 4020 account code).
--
-- A fundraiser reported QuickBooks records whose NOTES say they are "service
-- income" / "earned income" still sitting in the review queue. They are
-- fees-for-service / program revenue, never gifts. The existing `earned_income`
-- rule matched ONLY the "Services - Earned Income" (4020) income ACCOUNT — so a
-- deposit whose only earned-income signal lives in the free-text memo / note (no
-- 4020 line) slipped through. The classifier now ALSO matches an "earned income"
-- / "service income" whole-word phrase on the memo (raw_reference) or line
-- description.
--
-- This file has TWO independent, idempotent parts:
--   PART A — migrate the persisted INGEST rule so NEW pulls auto-exclude.
--   PART B — backfill the EXISTING review queue.
-- Both reuse the existing `earned_income` exclusion_reason — NO enum change
-- (earned_income was added by 0027 and already exists in prod).
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0045_quickbooks_earned_income_memo_backfill.sql

BEGIN;

-- ===========================================================================
-- PART A — INGEST rule (affects NEW incoming payments).
--
-- New QuickBooks pulls are classified by the DB-backed, admin-editable
-- `quickbooks_handling_rules` table (loaded by quickbooksSync.ts), NOT by the
-- in-code SEED_RULES. Migration 0040 seeded `seed_earned_income` with only the
-- single 4020 account-code condition, so without this update prod would keep
-- queuing memo-only "earned/service income" rows even after the new code ships.
--
-- This appends the two memo / line-description regex conditions (match_logic
-- stays "any", so it now fires on the 4020 account OR an earned/service-income
-- phrase), mirroring SEED_RULES.seed_earned_income in quickbooksRules.ts EXACTLY.
--
-- SAFETY / IDEMPOTENCY: fires ONLY when the row still holds its FULL ORIGINAL
-- seeded shape — the canonical single-4020 condition AND the semantic fields that
-- make appending the memo conditions a safe pure-broadening: action='exclude',
-- exclusion_reason='earned_income', donation_guard=true, match_logic='any'. If an
-- admin has customised ANY of those (e.g. flipped donation_guard off, which would
-- let the memo match hide bundled gifts, or set match_logic='all', which would
-- turn this into a narrowing), the WHERE clause skips the row entirely — the admin
-- must add the two conditions themselves from the admin page. Re-running after the
-- update is a no-op (the canonical-conditions test no longer matches). Nothing is
-- overwritten.
UPDATE quickbooks_handling_rules
   SET conditions = '[
         {"field":"line_account_name","mode":"prefix","value":"4020"},
         {"field":"memo_reference","mode":"regex","value":"\\bearned income\\b|\\bservice income\\b"},
         {"field":"line_description","mode":"regex","value":"\\bearned income\\b|\\bservice income\\b"}
       ]'::jsonb,
       updated_at = now()
 WHERE id = 'seed_earned_income'
   AND action = 'exclude'
   AND exclusion_reason = 'earned_income'
   AND donation_guard = true
   AND match_logic = 'any'
   AND conditions = '[{"field":"line_account_name","mode":"prefix","value":"4020"}]'::jsonb;

-- ===========================================================================
-- PART B — BACKFILL the existing review queue (affects ALREADY-queued rows).
--
-- Rule edits in Part A apply to NEW pulls only; queued rows are never
-- reclassified by the sync. This re-runs the refined `earned_income` rule over
-- the existing queue. Matching rows are marked status = 'excluded'. NOTHING is
-- deleted.
--
-- Mirrors classifyStagedPayment() in quickbooksExclusionRules.ts EXACTLY:
--   * earned_income is a GUARDED line rule — it fires only on rows that do NOT
--     also carry a real donation line (a 4000/4100 donation account or a
--     "Donation" item), so a deposit bundling a gift with an earned-income memo
--     is never wrongly hidden.
--   * Match = the 4020 account code (already swept by earlier runs; included here
--     so this is a complete, idempotent mirror) OR an "earned income" / "service
--     income" whole-word phrase on the memo OR the line description, each tested
--     SEPARATELY (a phrase split across the two fields is intentionally not a
--     match). Word-anchored (`\m…\M`) so "unearned income" cannot match.
--
-- RULE PRECEDENCE (first-match-wins): every rule HIGHER than earned_income has
-- already excluded its rows via earlier migrations, so this pending-only update
-- cannot steal them; the phrases "earned/service income" contain no higher-rule
-- marker, so there is no overlap in practice either.
--
-- SAFETY / IDEMPOTENCY: touches ONLY rows currently status = 'pending' AND
-- classification_source = 'auto' — approved / rejected / already-excluded rows
-- and any row a fundraiser manually re-included (classification_source =
-- 'manual') are never modified, so prior decisions are preserved and re-running
-- is a no-op. The memo match works on the historical back-catalog without a
-- re-pull because raw_reference (the deposit memo) is captured on every staged
-- row; the 4020 account / line_description clauses additionally benefit from line
-- detail (rows missing it are simply not matched by those clauses, no error).
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'earned_income',
       updated_at = now()
 WHERE status = 'pending'
   AND classification_source = 'auto'
   -- donation-first guard: skip rows that ALSO carry a real donation line
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                    WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                    WHERE lower(btrim(li)) LIKE '%donation%')
   -- earned income: 4020 account code OR an "earned/service income" memo / line
   AND ( EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                  WHERE lower(btrim(a)) LIKE '4020%')
      OR coalesce(raw_reference, '')    ~* '\m(earned|service) income\M'
      OR coalesce(line_description, '') ~* '\m(earned|service) income\M' );

-- Verification:
--   SELECT status, exclusion_reason, count(*)
--   FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;
--   SELECT conditions FROM quickbooks_handling_rules WHERE id = 'seed_earned_income';

COMMIT;
