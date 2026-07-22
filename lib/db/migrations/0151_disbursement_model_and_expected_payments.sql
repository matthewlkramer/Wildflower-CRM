-- 0151 — Pledge disbursement-model split + expected-payment installments (Task #788)
--
-- Additive + idempotent. Apply with:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0151_disbursement_model_and_expected_payments.sql
-- (No BEGIN/COMMIT here — psql -1 wraps the file in one transaction.)
--
-- 1. New enums: disbursement_model, award_close_reason.
-- 2. Pledge header: disbursement_model (NOT NULL default fixed_commitment),
--    award_closed_at, award_close_reason.
-- 3. New pledge_expected_payments installments table (+ indexes).
-- 4. gift_allocations: source_pledge_allocation_id (FK, set-null), variance_reason.
-- 5. Backfill: pledges with any allocation conditional='reimbursable'
--    → disbursement_model='cost_reimbursement'.
-- 6. Seed installments from deprecated pledge_allocations.expected_payment_date
--    (allocations sharing a date = ONE logical expected payment; amount =
--    SUM(sub_amount) over that date's rows, NULL if all sub_amounts are NULL).
--    The old column is retained (@deprecated, no new readers/writers).

DO $$ BEGIN
  CREATE TYPE disbursement_model AS ENUM ('fixed_commitment', 'cost_reimbursement');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE award_close_reason AS ENUM ('fully_collected', 'award_period_ended', 'unused_balance', 'terminated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE opportunities_and_pledges
  ADD COLUMN IF NOT EXISTS disbursement_model disbursement_model NOT NULL DEFAULT 'fixed_commitment',
  ADD COLUMN IF NOT EXISTS award_closed_at date,
  ADD COLUMN IF NOT EXISTS award_close_reason award_close_reason;

CREATE TABLE IF NOT EXISTS pledge_expected_payments (
  id text PRIMARY KEY,
  pledge_or_opportunity_id text NOT NULL REFERENCES opportunities_and_pledges(id) ON DELETE RESTRICT,
  expected_date date NOT NULL,
  amount numeric(14, 2),
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pledge_expected_payments_pledge_idx
  ON pledge_expected_payments (pledge_or_opportunity_id);
CREATE INDEX IF NOT EXISTS pledge_expected_payments_expected_date_idx
  ON pledge_expected_payments (expected_date);

ALTER TABLE gift_allocations
  ADD COLUMN IF NOT EXISTS source_pledge_allocation_id text REFERENCES pledge_allocations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS variance_reason text;

-- 5. Reclassify existing reimbursable-condition pledges (idempotent: only
--    flips rows still at the default).
UPDATE opportunities_and_pledges o
SET disbursement_model = 'cost_reimbursement'
WHERE o.disbursement_model = 'fixed_commitment'
  AND EXISTS (
    SELECT 1 FROM pledge_allocations pa
    WHERE pa.pledge_or_opportunity_id = o.id
      AND pa.conditional = 'reimbursable'
  );

-- 6. Seed installments from the deprecated per-allocation expected dates.
--    One installment per (pledge, date); idempotent via NOT EXISTS.
INSERT INTO pledge_expected_payments (id, pledge_or_opportunity_id, expected_date, amount)
SELECT
  gen_random_uuid()::text,
  pa.pledge_or_opportunity_id,
  pa.expected_payment_date,
  SUM(pa.sub_amount)
FROM pledge_allocations pa
WHERE pa.expected_payment_date IS NOT NULL
GROUP BY pa.pledge_or_opportunity_id, pa.expected_payment_date
HAVING NOT EXISTS (
  SELECT 1 FROM pledge_expected_payments pep
  WHERE pep.pledge_or_opportunity_id = pa.pledge_or_opportunity_id
    AND pep.expected_date = pa.expected_payment_date
);
