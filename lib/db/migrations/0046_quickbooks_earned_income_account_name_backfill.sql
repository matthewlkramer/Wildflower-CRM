-- Migration 0046: earned income recognised by the account NAME, not just the
-- 4020 account CODE.
--
-- Follow-up to 0045. After 0045 shipped, fees-for-service deposits were STILL
-- sitting in the review queue. Diagnosis: the records are coded to the income
-- account by its NAME — the bare "Services - Earned Income" — with NO leading
-- "4020" code, and their memo / line description are empty (or just "Paid via
-- QuickBooks Payments: Payment ID …"). QuickBooks emits the same income account
-- both WITH and WITHOUT its leading code, so the 4020-prefix-only match (0040)
-- plus the memo-phrase match (0045) both missed the code-less variant, which is
-- the dominant shape in the live queue. The classifier now ALSO matches an
-- "earned income" / "service income" whole-word phrase on the account NAME.
--
-- The payer / customer NAME is deliberately NOT matched: names like "DC
-- Wildflower PCS - Service Revenue" sit on real grants (4030 Other Revenue) and
-- donations, which must stay in the queue / remain gifts.
--
-- This file has TWO independent, idempotent parts:
--   PART A — migrate the persisted INGEST rule so NEW pulls auto-exclude.
--   PART B — backfill the EXISTING review queue.
-- Both reuse the existing `earned_income` exclusion_reason — NO enum change.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0046_quickbooks_earned_income_account_name_backfill.sql

BEGIN;

-- ===========================================================================
-- PART A — INGEST rule (affects NEW incoming payments).
--
-- New QuickBooks pulls are classified by the DB-backed, admin-editable
-- `quickbooks_handling_rules` table (loaded by quickbooksSync.ts), NOT by the
-- in-code SEED_RULES. This appends a fourth condition — an "earned/service
-- income" regex on the account NAME (line_account_name) — to the
-- `seed_earned_income` rule, mirroring SEED_RULES.seed_earned_income in
-- quickbooksRules.ts EXACTLY (match_logic stays "any").
--
-- SAFETY / IDEMPOTENCY: fires ONLY when the row still holds a KNOWN canonical
-- shape AND the semantic fields that make appending the account-name condition a
-- safe pure-broadening (action='exclude', exclusion_reason='earned_income',
-- donation_guard=true, match_logic='any'). The IN-list accepts BOTH the original
-- 0040 single-4020 seed AND the post-0045 three-condition shape, so this applies
-- whether or not 0045 was run. If an admin customised ANY of those fields or the
-- condition list, the WHERE clause skips the row — the admin must add the
-- condition from the admin page. Re-running after the update is a no-op (the
-- final four-condition shape is not in the IN-list). Nothing is overwritten.
UPDATE quickbooks_handling_rules
   SET conditions = '[
         {"field":"line_account_name","mode":"prefix","value":"4020"},
         {"field":"memo_reference","mode":"regex","value":"\\bearned income\\b|\\bservice income\\b"},
         {"field":"line_description","mode":"regex","value":"\\bearned income\\b|\\bservice income\\b"},
         {"field":"line_account_name","mode":"regex","value":"\\bearned income\\b|\\bservice income\\b"}
       ]'::jsonb,
       updated_at = now()
 WHERE id = 'seed_earned_income'
   AND action = 'exclude'
   AND exclusion_reason = 'earned_income'
   AND donation_guard = true
   AND match_logic = 'any'
   AND conditions IN (
     -- original 0040 seed (0045 not run here)
     '[{"field":"line_account_name","mode":"prefix","value":"4020"}]'::jsonb,
     -- post-0045 three-condition shape
     '[
        {"field":"line_account_name","mode":"prefix","value":"4020"},
        {"field":"memo_reference","mode":"regex","value":"\\bearned income\\b|\\bservice income\\b"},
        {"field":"line_description","mode":"regex","value":"\\bearned income\\b|\\bservice income\\b"}
      ]'::jsonb
   );

-- ===========================================================================
-- PART B — BACKFILL the existing review queue (affects ALREADY-queued rows).
--
-- Rule edits in Part A apply to NEW pulls only; queued rows are never
-- reclassified by the sync. This re-runs the refined `earned_income` rule over
-- the existing queue. Matching rows are marked status = 'excluded'. NOTHING is
-- deleted.
--
-- Mirrors classifyStagedPayment() / isEarnedIncomeLine() in
-- quickbooksExclusionRules.ts EXACTLY:
--   * earned_income is a GUARDED line rule — it fires only on rows that do NOT
--     also carry a real donation line (a 4000/4100 donation account or a
--     "Donation" item), so a deposit bundling a gift with an earned-income line
--     is never wrongly hidden.
--   * Match = the 4020 account code (per-element, mirrors prefix mode) OR an
--     "earned income" / "service income" whole-word phrase on the memo, the line
--     description, OR the account NAME. The memo and line description are tested
--     per-field; the account NAMES are joined with a space first
--     (array_to_string) to mirror the engine's `vals.join(" ")` for the
--     multi-value line_account_name regex. Word-anchored (`\m…\M`) so "unearned
--     income" cannot match. The payer NAME is intentionally never tested.
--
-- RULE PRECEDENCE (first-match-wins): every rule HIGHER than earned_income has
-- already excluded its rows via earlier migrations, so this pending-only update
-- cannot steal them; in particular interest (4040/4010) outranks earned_income,
-- but an "earned/service income" phrase carries no higher-rule marker.
--
-- SAFETY / IDEMPOTENCY: touches ONLY rows currently status = 'pending' AND
-- classification_source = 'auto' — approved / rejected / already-excluded rows
-- and any row a fundraiser manually re-included (classification_source =
-- 'manual') are never modified, so prior decisions are preserved and re-running
-- is a no-op. The account-name / memo match works on the historical back-catalog
-- without a re-pull (those fields are captured on every staged row).
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
   -- earned income: 4020 account code (per-element) OR an "earned/service
   -- income" phrase on the memo, the line description, or the account NAME
   -- (account names joined to mirror the engine's multi-value regex).
   AND ( EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                  WHERE lower(btrim(a)) LIKE '4020%')
      OR coalesce(raw_reference, '')    ~* '\m(earned|service) income\M'
      OR coalesce(line_description, '') ~* '\m(earned|service) income\M'
      OR array_to_string(coalesce(line_account_names, '{}'::text[]), ' ') ~* '\m(earned|service) income\M' );

-- Verification:
--   SELECT status, exclusion_reason, count(*)
--   FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;
--   SELECT conditions FROM quickbooks_handling_rules WHERE id = 'seed_earned_income';

COMMIT;
