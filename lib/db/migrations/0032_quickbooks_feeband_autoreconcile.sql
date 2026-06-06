-- Migration 0032: Auto-reconcile fee-only, single-candidate staged payments
--
-- Companion to the matcher change (reconcileTarget() in quickbooksMatch.ts) that,
-- going forward, auto-reconciles a staged payment to a SINGLE fee-band gift when
-- no exact-amount gift exists (the QB net deposit is the gift gross minus a
-- processor fee). This file catches up the rows already sitting in "Needs review"
-- that the OLD matcher left pending because it only auto-reconciled a single
-- EXACT-amount gift.
--
-- Scope (mirrors reconcileTarget(), high-confidence donor only):
--   * status = 'pending' AND match_score >= 95  (donor is high-confidence)
--   * within +-60 days of the staged date, EXCLUDING gifts already linked to
--     another staged payment, the resolved donor has:
--       - ZERO exact-amount gifts (amount within $0.01), AND
--       - EXACTLY ONE fee-band gift (gross in [net - 0.01, net * 1.10 + 1]).
--   * that one gift is the single candidate for exactly one staged row, so two
--     staged rows never claim the same gift (respects the partial-unique index on
--     matched_gift_id).
-- Matching rows are RECONCILED to that gift and moved to the Auto-matched queue
-- (status='approved', auto_applied=true, match_confirmed_at left NULL) for
-- optional human review. The gift row is NOT modified -- it already holds the
-- gross amount; the fee is the implicit difference from the QB net deposit.
--
-- Rows with two-or-more exact gifts, or two-or-more fee-band gifts, stay in Needs
-- review -- they are genuinely ambiguous and a human must pick.
--
-- SAFETY / IDEMPOTENCY:
--   * Only touches still-'pending', still-unlinked rows; re-running is a no-op
--     (reconciled rows become 'approved', and their gift is then "already linked"
--     so it is excluded next time).
--   * Expected to move ~18 rows (verified against production 2026-06-06).
--   * To also sweep the few score 90-94 rows, change `>= 95` to `>= 90` below.
--
-- APPLY (human, reviewed):
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0032_quickbooks_feeband_autoreconcile.sql

BEGIN;

WITH band AS (
  SELECT p.id AS staged_id,
         g.id AS gift_id,
         (abs(g.amount - p.amount::numeric) <= 0.01) AS is_exact
    FROM staged_payments p
    JOIN gifts_and_payments g
      -- Mirror donorWhere() precedence (org > person > household), NOT an OR
      -- across all FKs, so the candidate set matches the runtime matcher even if
      -- a row ever had more than one donor FK set.
      ON ( (p.organization_id IS NOT NULL
            AND g.organization_id = p.organization_id)
        OR (p.organization_id IS NULL
            AND p.individual_giver_person_id IS NOT NULL
            AND g.individual_giver_person_id = p.individual_giver_person_id)
        OR (p.organization_id IS NULL
            AND p.individual_giver_person_id IS NULL
            AND p.household_id IS NOT NULL
            AND g.household_id = p.household_id) )
     AND g.amount >= p.amount::numeric - 0.01
     AND g.amount <= p.amount::numeric * 1.10 + 1
     -- Mirror giftsInWindow(): a null staged date applies NO date filter.
     AND (p.date_received IS NULL
          OR g.date_received IS NULL
          OR abs(g.date_received - p.date_received) <= 60)
     AND NOT EXISTS (
           SELECT 1 FROM staged_payments s2
            WHERE s2.matched_gift_id = g.id
               OR s2.created_gift_id = g.id
         )
   WHERE p.status = 'pending'
     AND p.match_score >= 95
     AND p.matched_gift_id IS NULL
     AND p.created_gift_id IS NULL
),
-- Keep only staged rows with EXACTLY ONE band gift and ZERO exact gifts: the
-- single fee-band candidate.
per_staged AS (
  SELECT staged_id,
         min(gift_id) AS only_gift_id
    FROM band
   GROUP BY staged_id
  HAVING count(*) = 1
     AND count(*) FILTER (WHERE is_exact) = 0
),
-- Keep only gifts claimed by exactly one staged row (no double-link).
gift_once AS (
  SELECT only_gift_id
    FROM per_staged
   GROUP BY only_gift_id
  HAVING count(*) = 1
),
final AS (
  SELECT ps.staged_id, ps.only_gift_id AS gift_id
    FROM per_staged ps
    JOIN gift_once go ON go.only_gift_id = ps.only_gift_id
)
UPDATE staged_payments p
   SET matched_gift_id = f.gift_id,
       status          = 'approved',
       match_status    = 'matched',
       auto_applied    = true,
       updated_at      = now()
  FROM final f
 WHERE p.id = f.staged_id
   AND p.status = 'pending'
   AND p.matched_gift_id IS NULL
   AND p.created_gift_id IS NULL;

-- Verification (run inside the same transaction before COMMIT):
--   SELECT count(*) AS moved
--     FROM staged_payments
--    WHERE status = 'approved' AND auto_applied
--      AND match_confirmed_at IS NULL
--      AND match_status = 'matched'
--      AND matched_gift_id IS NOT NULL
--      AND updated_at >= now() - interval '1 minute';
--   -- expect ~18

COMMIT;
