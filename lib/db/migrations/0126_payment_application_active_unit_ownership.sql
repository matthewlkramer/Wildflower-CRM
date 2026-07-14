-- Enforce one active gift owner per non-splittable processor unit.
--
-- A Stripe charge or Donorbox donation may have at most one active counted
-- application across proposed + confirmed lifecycles. Exempt rows are historical
-- and intentionally excluded. QuickBooks payments are not constrained here
-- because they may be split across gifts.

BEGIN;

DO $$
DECLARE
  stripe_conflicts integer;
  donorbox_conflicts integer;
BEGIN
  SELECT count(*) INTO stripe_conflicts
  FROM (
    SELECT stripe_charge_id
    FROM payment_applications
    WHERE stripe_charge_id IS NOT NULL
      AND link_role = 'counted'
      AND lifecycle IN ('proposed', 'confirmed')
    GROUP BY stripe_charge_id
    HAVING count(DISTINCT gift_id) > 1
  ) conflicts;

  IF stripe_conflicts > 0 THEN
    RAISE EXCEPTION
      '0126 aborted: % Stripe charges have multiple active counted gift owners',
      stripe_conflicts;
  END IF;

  SELECT count(*) INTO donorbox_conflicts
  FROM (
    SELECT donorbox_donation_id
    FROM payment_applications
    WHERE donorbox_donation_id IS NOT NULL
      AND link_role = 'counted'
      AND lifecycle IN ('proposed', 'confirmed')
    GROUP BY donorbox_donation_id
    HAVING count(DISTINCT gift_id) > 1
  ) conflicts;

  IF donorbox_conflicts > 0 THEN
    RAISE EXCEPTION
      '0126 aborted: % Donorbox donations have multiple active counted gift owners',
      donorbox_conflicts;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_applications_stripe_charge_active_owner_uq
  ON payment_applications (stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL
    AND link_role = 'counted'
    AND lifecycle IN ('proposed', 'confirmed');

CREATE UNIQUE INDEX IF NOT EXISTS payment_applications_donorbox_donation_active_owner_uq
  ON payment_applications (donorbox_donation_id)
  WHERE donorbox_donation_id IS NOT NULL
    AND link_role = 'counted'
    AND lifecycle IN ('proposed', 'confirmed');

COMMIT;
