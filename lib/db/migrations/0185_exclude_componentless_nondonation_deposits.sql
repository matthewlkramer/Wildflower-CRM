-- 0185: one-time bank-deposit-level exclusion of componentless deposits whose
-- QB accounting records are entirely non-donation (585 reviewed deposits).
--
-- Scope: bank deposits with NO decomposition (no settling Stripe payout, no
-- bank_deposit_components) that are still OPEN (no existing
-- bank_deposit_exclusions row). QBO has an accounting record for essentially
-- every deposit (via deposit_qbo_components -> staged_payments), even if the
-- details aren't perfect, so those QB lines are the classification signal.
--
-- Rule (deliberately conservative): a deposit is excluded ONLY when EVERY QB
-- account across ALL of its records is a clear non-donation account, with ZERO
-- donation lines (%Donation%) and ZERO ambiguous lines. Ambiguous accounts held
-- back for manual review: "4030 Other Revenue", "4099 Uncategorized Revenue",
-- "4102 Guaranty Revenue", and any record with no account at all. Deposits with
-- a real 4000*/4100* donation line are left in the fundraising queue.
--
-- Per-deposit reason is the highest-priority non-donation account it carries:
--   loan/credit/note  -> loan
--   membership        -> membership
--   earned income     -> earned_income
--   interest          -> interest
--   asset/transfer    -> intercompany_transfer
--   payroll/expense/grant-out/taxes -> expense_refund
--   other non-donation -> other
--
-- One-time backfill of a reviewed set, NOT a standing rule; no future deposit is
-- touched. Idempotent (ON CONFLICT (bank_deposit_id) DO NOTHING); re-running
-- affects zero rows. Overridable: delete a row to return that deposit to the
-- queue.
--
-- Requires 0175 (bank_deposit_exclusions). Apply with:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0185_exclude_componentless_nondonation_deposits.sql
--   then the same on $DATABASE_URL.

-- Componentless, still-open bank deposits.
CREATE TEMP VIEW _base_0185 AS
  SELECT d.id
  FROM bank_deposits d
  WHERE NOT EXISTS (SELECT 1 FROM stripe_payouts p WHERE p.bank_deposit_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM bank_deposit_components c WHERE c.bank_deposit_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM bank_deposit_exclusions e WHERE e.bank_deposit_id = d.id);

-- One row per (deposit, QB account) across all of the deposit's QB records.
CREATE TEMP VIEW _lines_0185 AS
  SELECT b.id AS dep,
    unnest(
      CASE WHEN COALESCE(array_length(s.line_account_names, 1), 0) = 0
           THEN ARRAY['(none)']
           ELSE s.line_account_names END
    ) AS a
  FROM _base_0185 b
  JOIN deposit_qbo_components dqc ON dqc.bank_deposit_id = b.id
  JOIN staged_payments s ON s.id = dqc.staged_payment_id;

-- Classify each account line and, for non-donation lines, give it a
-- (priority, reason) so the deposit's reason is its most specific type.
CREATE TEMP VIEW _classed_0185 AS
  SELECT dep, a,
    CASE
      WHEN a ILIKE '%donation%' THEN 'donation'
      WHEN a IN ('4030 Other Revenue', '4099 Uncategorized Revenue', '4102 Guaranty Revenue')
           OR a = '(none)' OR a ILIKE '%uncategorized revenue%' THEN 'ambiguous'
      ELSE 'nondonation'
    END AS cls,
    CASE
      WHEN a ILIKE '%loan%' OR a ILIKE '%line of credit%' OR a ILIKE '%note payable%' OR a ILIKE '%ppp%' THEN 1
      WHEN a ILIKE '%membership%' THEN 2
      WHEN a ILIKE '%earned income%' OR a ILIKE '%services -%' THEN 3
      WHEN a ILIKE '%interest%' THEN 4
      WHEN a ~ '^(100|150)' OR a ILIKE '%brokerage%' OR a ILIKE '%checking%' OR a ILIKE '%receivable%'
           OR a ILIKE '%clearing%' OR a ILIKE '%uncategorized asset%' OR a ILIKE '%bill.com%' THEN 5
      WHEN a ILIKE '%payroll%' OR a ILIKE '%benefit%' OR a ILIKE '%all other expenditures%'
           OR a ILIKE '%grants to schools%' OR a ILIKE '%research partnership%' OR a ILIKE '%taxes%' THEN 6
      ELSE 9
    END AS prio,
    CASE
      WHEN a ILIKE '%loan%' OR a ILIKE '%line of credit%' OR a ILIKE '%note payable%' OR a ILIKE '%ppp%' THEN 'loan'
      WHEN a ILIKE '%membership%' THEN 'membership'
      WHEN a ILIKE '%earned income%' OR a ILIKE '%services -%' THEN 'earned_income'
      WHEN a ILIKE '%interest%' THEN 'interest'
      WHEN a ~ '^(100|150)' OR a ILIKE '%brokerage%' OR a ILIKE '%checking%' OR a ILIKE '%receivable%'
           OR a ILIKE '%clearing%' OR a ILIKE '%uncategorized asset%' OR a ILIKE '%bill.com%' THEN 'intercompany_transfer'
      WHEN a ILIKE '%payroll%' OR a ILIKE '%benefit%' OR a ILIKE '%all other expenditures%'
           OR a ILIKE '%grants to schools%' OR a ILIKE '%research partnership%' OR a ILIKE '%taxes%' THEN 'expense_refund'
      ELSE 'other'
    END AS reason
  FROM _lines_0185;

-- A deposit qualifies iff every line is non-donation (>=1 line, no donation, no ambiguous).
CREATE TEMP VIEW _excludable_0185 AS
  SELECT dep
  FROM _classed_0185
  GROUP BY dep
  HAVING bool_or(cls = 'nondonation')
     AND NOT bool_or(cls = 'donation')
     AND NOT bool_or(cls = 'ambiguous');

-- One reason per qualifying deposit: its highest-priority non-donation type.
CREATE TEMP VIEW _reason_0185 AS
  SELECT DISTINCT ON (c.dep) c.dep, c.reason::staged_payment_exclusion_reason AS reason
  FROM _classed_0185 c
  JOIN _excludable_0185 e ON e.dep = c.dep
  ORDER BY c.dep, c.prio;

-- Before-state diagnostic (retain in the run log): expect 585 rows across reasons.
SELECT reason, count(*) AS deposits_to_exclude
FROM _reason_0185
GROUP BY reason
ORDER BY deposits_to_exclude DESC;

INSERT INTO bank_deposit_exclusions (id, bank_deposit_id, reason, note)
SELECT 'bdex_' || r.dep, r.dep, r.reason,
       'reviewed: componentless deposit, all QB accounts non-donation (0185)'
FROM _reason_0185 r
ON CONFLICT (bank_deposit_id) DO NOTHING;

-- After-state diagnostic: full deposit-level exclusion distribution.
SELECT reason, count(*) AS excluded_deposits
FROM bank_deposit_exclusions
GROUP BY reason
ORDER BY excluded_deposits DESC;

DROP VIEW _reason_0185;
DROP VIEW _excludable_0185;
DROP VIEW _classed_0185;
DROP VIEW _lines_0185;
DROP VIEW _base_0185;
