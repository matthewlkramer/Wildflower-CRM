-- Archive the duplicate Imaginable Futures $75k gift record.
--
-- Context: three identical $75k "MN emergency relief - immigration" gift
-- records exist for the 2026-07-17 wire deposit bdep_ec260b270a9fe38db53584ee.
-- Only one real payment occurred. The record kept is
-- N9DISqOnL-0gRqcwH8kMA, which holds the payment unit
-- (pu_manual_1wbTkWVzLIHJRXn1AfFyW) composed into the real bank deposit.
-- w7ki-Y7QyBYidyNlku0jm was already archived 2026-07-28.
-- pYsjKgvW1_9JtYnX_4kyD (created 2026-07-29) has no payment evidence and no
-- inbound references (payment_units, overpay, match children all verified 0).
--
-- Idempotent: WHERE archived_at IS NULL makes re-runs a no-op.

UPDATE gifts_and_payments
SET archived_at = now(), updated_at = now()
WHERE id = 'pYsjKgvW1_9JtYnX_4kyD'
  AND archived_at IS NULL;

-- Postflight: exactly one active $75k Imaginable Futures gift should remain.
DO $$
DECLARE active_count integer;
BEGIN
  SELECT count(*) INTO active_count
  FROM gifts_and_payments g
  JOIN organizations o ON o.id = g.organization_id
  WHERE o.name ILIKE '%imaginable%'
    AND g.amount = 75000.00
    AND g.date_received > '2026-06-01'
    AND g.archived_at IS NULL;
  IF active_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 active recent $75k Imaginable Futures gift, found %', active_count;
  END IF;
END $$;
