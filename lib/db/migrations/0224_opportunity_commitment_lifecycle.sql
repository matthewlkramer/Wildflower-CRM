BEGIN;

DO $$
BEGIN
  CREATE TYPE opportunity_commitment_path AS ENUM (
    'gift',
    'written_pledge',
    'verbal_pledge'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE opportunities_and_pledges
  ADD COLUMN IF NOT EXISTS commitment_path opportunity_commitment_path,
  ADD COLUMN IF NOT EXISTS verbal_commitment_at date,
  ADD COLUMN IF NOT EXISTS pledge_committed_at date;

CREATE INDEX IF NOT EXISTS opportunities_and_pledges_commitment_path_idx
  ON opportunities_and_pledges(commitment_path);
CREATE INDEX IF NOT EXISTS opportunities_and_pledges_pledge_committed_at_idx
  ON opportunities_and_pledges(pledge_committed_at);

UPDATE opportunities_and_pledges
SET
  commitment_path = CASE
    WHEN grant_letter_url IS NOT NULL THEN 'written_pledge'::opportunity_commitment_path
    ELSE 'verbal_pledge'::opportunity_commitment_path
  END,
  pledge_committed_at = COALESCE(
    grant_letter_uploaded_at::date,
    actual_completion_date,
    created_at::date
  ),
  verbal_commitment_at = COALESCE(
    grant_letter_uploaded_at::date,
    actual_completion_date,
    created_at::date
  )
WHERE written_pledge = true
  AND pledge_committed_at IS NULL;

WITH gift_outcomes AS (
  SELECT
    opportunity_id,
    MIN(date_received) FILTER (WHERE date_received IS NOT NULL) AS first_payment_date,
    SUM(COALESCE(amount, 0)) AS total_paid
  FROM gifts_and_payments
  WHERE archived_at IS NULL
    AND opportunity_id IS NOT NULL
  GROUP BY opportunity_id
)
UPDATE opportunities_and_pledges o
SET actual_completion_date = COALESCE(
  o.actual_completion_date,
  g.first_payment_date
)
FROM gift_outcomes g
WHERE g.opportunity_id = o.id
  AND g.total_paid > 0
  AND o.pledge_committed_at IS NULL;

UPDATE opportunities_and_pledges
SET stage = 'verbal_confirmation'
WHERE stage IN (
  'complete',
  'cash_in',
  'written_commitment',
  'conditional_commitment'
);

UPDATE opportunities_and_pledges
SET written_pledge = (pledge_committed_at IS NOT NULL);

ALTER TABLE opportunities_and_pledges
  DROP CONSTRAINT IF EXISTS opp_commitment_path_requires_date,
  ADD CONSTRAINT opp_commitment_path_requires_date CHECK (
    (commitment_path IS NULL AND verbal_commitment_at IS NULL)
    OR
    (commitment_path IS NOT NULL AND verbal_commitment_at IS NOT NULL)
  );

ALTER TABLE opportunities_and_pledges
  DROP CONSTRAINT IF EXISTS opp_pledge_commitment_path,
  ADD CONSTRAINT opp_pledge_commitment_path CHECK (
    pledge_committed_at IS NULL
    OR commitment_path IN ('written_pledge', 'verbal_pledge')
  );

ALTER TABLE opportunities_and_pledges
  DROP CONSTRAINT IF EXISTS opp_written_pledge_requires_document,
  ADD CONSTRAINT opp_written_pledge_requires_document CHECK (
    pledge_committed_at IS NULL
    OR commitment_path <> 'written_pledge'
    OR grant_letter_url IS NOT NULL
  );

COMMIT;
