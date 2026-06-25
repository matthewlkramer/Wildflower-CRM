-- 0076_cmo_csp_grant_reconciliation.sql
--
-- DATA-ONLY production cleanup of the U.S. Department of Education
-- "CMO Replication / CSP" grant. No schema or app-code changes.
--
-- Donor org : U.S. Department of Education  recHG2Cva8hJRzB6Y (issues_grants = true)
-- Core pledge: recX8CNJdnAq66sdR  ("CMO Replication Grant - pass through funds")
--
-- What this does (see the RUNBOOK for the full rationale + verification):
--   A. Rebuild the core pledge's 10 allocations ($12.7M total).
--   B. Archive the duplicate $1M pledge recZ4qDrnKGhOyrq2 and its 3
--      "national funds" gifts (separate money — archived, NOT converted).
--   C. Mint one gift + two split allocations + one QB cash-application ledger
--      row for each of the 61 pending, non-zero, payer_name='CSP' deposits.
--   D. Resolve each of those 61 staged payments out of the review queue,
--      mirroring the reconciler's create_gift terminal state.
--   E. Repurpose the core pledge header to the single $12.7M grant pledge,
--      with status/stage/paid/win_probability mirroring deriveOppFields.
--
-- Idempotent: deterministic ids + ON CONFLICT + guarded UPDATEs. Re-running
-- after a successful apply is a no-op.
--
-- Applied by a human (the agent cannot write prod):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0076_cmo_csp_grant_reconciliation.sql
--
-- NOTE: no BEGIN/COMMIT here — psql -1 wraps the whole file in one transaction.

-- ──────────────────────────────────────────────────────────────────────────
-- Guard: the per-deposit split depends on each deposit's fiscal year. The split
-- rule is only defined for FY2024–FY2026 (FY24/25 = 10% gen ops, FY26 = 15%).
-- If any in-scope CSP deposit falls outside that window, STOP rather than guess.
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM staged_payments sp
    WHERE sp.payer_name = 'CSP'
      AND sp.status = 'pending'
      AND sp.amount IS NOT NULL AND sp.amount <> 0
      AND NOT (sp.date_received BETWEEN DATE '2023-07-01' AND DATE '2026-06-30')
  ) THEN
    RAISE EXCEPTION
      'CSP deposit outside FY2024-FY2026 found; aborting (split rule undefined — needs human review)';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- A. Rebuild the core pledge's allocations on recX8CNJdnAq66sdR.
--    Delete the synthetic $9.6M allocation, then upsert the 10 real rows.
-- ══════════════════════════════════════════════════════════════════════════
DELETE FROM pledge_allocations
WHERE id = 'synth-pa-recX8CNJdnAq66sdR-wildflower_foundation-fy2024';

INSERT INTO pledge_allocations (
  id, pledge_or_opportunity_id, sub_amount, grant_year, entity_id,
  intended_usage, fundable_project_id, formally_restricted, reimbursable_share,
  created_at, updated_at
)
VALUES
  -- Charter Growth — project, formally restricted, DIRECT (does NOT count toward goal)
  ('cmo-pa-fy2024-charter', 'recX8CNJdnAq66sdR', 2286000, 'fy2024', 'wildflower_foundation', 'project', 'charter_growth', true,  'direct',   now(), now()),
  ('cmo-pa-fy2025-charter', 'recX8CNJdnAq66sdR', 2286000, 'fy2025', 'wildflower_foundation', 'project', 'charter_growth', true,  'direct',   now(), now()),
  ('cmo-pa-fy2026-charter', 'recX8CNJdnAq66sdR', 2159000, 'fy2026', 'wildflower_foundation', 'project', 'charter_growth', true,  'direct',   now(), now()),
  ('cmo-pa-fy2027-charter', 'recX8CNJdnAq66sdR', 2159000, 'fy2027', 'wildflower_foundation', 'project', 'charter_growth', true,  'direct',   now(), now()),
  ('cmo-pa-fy2028-charter', 'recX8CNJdnAq66sdR', 2159000, 'fy2028', 'wildflower_foundation', 'project', 'charter_growth', true,  'direct',   now(), now()),
  -- Gen Ops — no project, INDIRECT (counts toward goal)
  ('cmo-pa-fy2024-genops',  'recX8CNJdnAq66sdR',  254000, 'fy2024', 'wildflower_foundation', 'gen_ops', NULL,            false, 'indirect', now(), now()),
  ('cmo-pa-fy2025-genops',  'recX8CNJdnAq66sdR',  254000, 'fy2025', 'wildflower_foundation', 'gen_ops', NULL,            false, 'indirect', now(), now()),
  ('cmo-pa-fy2026-genops',  'recX8CNJdnAq66sdR',  381000, 'fy2026', 'wildflower_foundation', 'gen_ops', NULL,            false, 'indirect', now(), now()),
  ('cmo-pa-fy2027-genops',  'recX8CNJdnAq66sdR',  381000, 'fy2027', 'wildflower_foundation', 'gen_ops', NULL,            false, 'indirect', now(), now()),
  ('cmo-pa-fy2028-genops',  'recX8CNJdnAq66sdR',  381000, 'fy2028', 'wildflower_foundation', 'gen_ops', NULL,            false, 'indirect', now(), now())
ON CONFLICT (id) DO UPDATE SET
  pledge_or_opportunity_id = EXCLUDED.pledge_or_opportunity_id,
  sub_amount               = EXCLUDED.sub_amount,
  grant_year               = EXCLUDED.grant_year,
  entity_id                = EXCLUDED.entity_id,
  intended_usage           = EXCLUDED.intended_usage,
  fundable_project_id      = EXCLUDED.fundable_project_id,
  formally_restricted      = EXCLUDED.formally_restricted,
  reimbursable_share       = EXCLUDED.reimbursable_share,
  updated_at               = now();

-- ══════════════════════════════════════════════════════════════════════════
-- B. Archive the duplicate $1M pledge and its 3 "national funds" gifts.
--    Separate money — archived, never converted. Guarded so re-runs no-op.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE opportunities_and_pledges
SET archived_at = now(), updated_at = now()
WHERE id = 'recZ4qDrnKGhOyrq2' AND archived_at IS NULL;

UPDATE gifts_and_payments
SET archived_at = now(), updated_at = now()
WHERE id IN ('recQxIzArMnFEdgVS', 'recgONhEnsP3p8B59', 'recuk5liHKVem9aOh')
  AND archived_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- C. Per-deposit gifts. For each of the 61 pending non-zero CSP staged rows:
--    one gift header + a gen-ops/charter allocation split + a QB
--    cash-application ledger row (so the gift derives quickbooks_tie='tied').
--    Split: FY24/25 = 10% gen ops + 90% charter; FY26 = 15% gen ops + 85%.
--    The gen-ops sub_amount is round(amount*pct,2); charter takes the remainder
--    so the two lines sum to the gift amount exactly.
-- ══════════════════════════════════════════════════════════════════════════

-- C1. Gift headers. organization donor (XOR), QB final-amount source pointing
--     back to the staged row, counts_toward_goal=true at the header (the goal
--     split is enforced at the allocation level via reimbursable_share).
INSERT INTO gifts_and_payments (
  id, name, date_received, amount, organization_id, type, loan_or_grant,
  opportunity_id, grant_year, owner_user_id, counts_toward_goal,
  final_amount_source, final_amount_qb_staged_payment_id, quickbooks_tie_status,
  created_at, updated_at
)
SELECT
  'csp-gift-' || sp.id,
  'CMO Replication Grant - CSP reimbursement ' || to_char(sp.date_received, 'YYYY-MM-DD'),
  sp.date_received,
  sp.amount,
  'recHG2Cva8hJRzB6Y',
  'pledge_payment',
  'grant',
  'recX8CNJdnAq66sdR',
  fy.id,
  'usr_matthew_kramer',
  true,
  'quickbooks',
  sp.id,
  'tied',
  now(), now()
FROM staged_payments sp
JOIN fiscal_years fy ON sp.date_received BETWEEN fy.start_date AND fy.end_date
WHERE sp.payer_name = 'CSP'
  AND sp.status = 'pending'
  AND sp.amount IS NOT NULL AND sp.amount <> 0
ON CONFLICT (id) DO NOTHING;

-- C2. Gen-ops allocation (counts toward goal → reimbursable_share='indirect').
INSERT INTO gift_allocations (
  id, gift_id, sub_amount, grant_year, entity_id, intended_usage,
  reimbursable_share, formal_fund_use_restriction, formal_regional_restriction,
  created_at, updated_at
)
SELECT
  'csp-ga-' || sp.id || '-genops',
  'csp-gift-' || sp.id,
  ROUND(sp.amount * (CASE WHEN fy.id = 'fy2026' THEN 0.15 ELSE 0.10 END), 2),
  fy.id,
  'wildflower_foundation',
  'gen_ops',
  'indirect',
  false,
  false,
  now(), now()
FROM staged_payments sp
JOIN fiscal_years fy ON sp.date_received BETWEEN fy.start_date AND fy.end_date
WHERE sp.payer_name = 'CSP'
  AND sp.status = 'pending'
  AND sp.amount IS NOT NULL AND sp.amount <> 0
ON CONFLICT (id) DO NOTHING;

-- C3. Charter-growth allocation (does NOT count → reimbursable_share='direct',
--     formally restricted, project=charter_growth). Remainder so the two lines
--     sum exactly to the gift amount.
INSERT INTO gift_allocations (
  id, gift_id, sub_amount, grant_year, entity_id, intended_usage,
  fundable_project_id, reimbursable_share, formal_fund_use_restriction,
  formal_regional_restriction, created_at, updated_at
)
SELECT
  'csp-ga-' || sp.id || '-charter',
  'csp-gift-' || sp.id,
  sp.amount - ROUND(sp.amount * (CASE WHEN fy.id = 'fy2026' THEN 0.15 ELSE 0.10 END), 2),
  fy.id,
  'wildflower_foundation',
  'project',
  'charter_growth',
  'direct',
  true,
  false,
  now(), now()
FROM staged_payments sp
JOIN fiscal_years fy ON sp.date_received BETWEEN fy.start_date AND fy.end_date
WHERE sp.payer_name = 'CSP'
  AND sp.status = 'pending'
  AND sp.amount IS NOT NULL AND sp.amount <> 0
ON CONFLICT (id) DO NOTHING;

-- C4. QB cash-application ledger row (the read-cutover deriver reads this; a
--     new gift with no ledger row would derive as 'missing'). amount_applied =
--     the QB-settled staged amount; this application MINTED the gift.
INSERT INTO payment_applications (
  id, payment_id, gift_id, amount_applied, evidence_source, match_method,
  confirmed_by_user_id, confirmed_at, created_the_gift, created_at, updated_at
)
SELECT
  'csp-pa-' || sp.id,
  sp.id,
  'csp-gift-' || sp.id,
  sp.amount,
  'quickbooks',
  'human',
  'usr_matthew_kramer',
  now(),
  true,
  now(), now()
FROM staged_payments sp
WHERE sp.payer_name = 'CSP'
  AND sp.status = 'pending'
  AND sp.amount IS NOT NULL AND sp.amount <> 0
ON CONFLICT (payment_id, gift_id) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════
-- D. Resolve the 61 staged payments out of the review queue, mirroring the
--    reconciler create_gift terminal state. Guarded on status='pending' (so an
--    already-resolved row is never clobbered) and on the gift existing.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE staged_payments sp
SET
  status                   = 'reconciled',
  created_gift_id          = 'csp-gift-' || sp.id,
  matched_gift_id          = NULL,
  auto_applied             = false,
  match_status             = 'matched',
  match_confirmed_by_user_id = 'usr_matthew_kramer',
  match_confirmed_at       = now(),
  approved_by_user_id      = 'usr_matthew_kramer',
  approved_at              = now(),
  updated_at               = now()
WHERE sp.payer_name = 'CSP'
  AND sp.status = 'pending'
  AND sp.amount IS NOT NULL AND sp.amount <> 0
  AND EXISTS (SELECT 1 FROM gifts_and_payments g WHERE g.id = 'csp-gift-' || sp.id);

-- ══════════════════════════════════════════════════════════════════════════
-- E. Repurpose the core pledge header into the single $12.7M grant pledge.
--    status/stage/win_probability/paid mirror deriveOppFields exactly:
--      written_pledge=true and paid (~$4.9M) < awarded ($12.7M) ⇒ status='pledge',
--      a won row reads stage='complete', non-conditional pledge ⇒ win_prob=0.9000,
--      paid = SUM of linked non-archived gift amounts.
--    Runs after C so the paid subquery sees the new gifts.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE opportunities_and_pledges
SET
  ask_amount             = 12700000,
  awarded_amount         = 12700000,
  loan_or_grant          = 'grant',
  written_pledge         = true,
  actual_completion_date = DATE '2023-03-31',
  status                 = 'pledge',
  stage                  = 'complete',
  win_probability        = 0.9000,
  paid = (
    SELECT COALESCE(SUM(g.amount), 0)
    FROM gifts_and_payments g
    WHERE g.opportunity_id = 'recX8CNJdnAq66sdR'
      AND g.archived_at IS NULL
  ),
  updated_at = now()
WHERE id = 'recX8CNJdnAq66sdR';
