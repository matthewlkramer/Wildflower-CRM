-- 0127_stripe_auto_apply_ledger_bridge.sql
--
-- Rolling-deploy compatibility bridge for the Stripe ledger-first cutover.
-- Older sync code may still:
--   1. write matched_gift_id with auto_applied=true; and
--   2. call bookStripeChargeApplication with match_method='system', no confirmer.
--
-- The authoritative model requires:
--   * lifecycle='proposed' until a human confirms;
--   * no Stripe gift pointer for an unconfirmed proposal.
--
-- Enforce those semantics at the database boundary so old and new application
-- processes can run concurrently during deployment. Remove these triggers after
-- every Stripe proposal writer calls proposeStripeChargeApplication directly.

BEGIN;

CREATE OR REPLACE FUNCTION normalize_stripe_system_application_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.evidence_source = 'stripe'
     AND NEW.link_role = 'counted'
     AND NEW.match_method = 'system'
     AND NEW.confirmed_by_user_id IS NULL
     AND NEW.confirmed_at IS NULL THEN
    NEW.lifecycle := 'proposed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_applications_normalize_stripe_system_lifecycle
  ON payment_applications;

CREATE TRIGGER payment_applications_normalize_stripe_system_lifecycle
BEFORE INSERT OR UPDATE ON payment_applications
FOR EACH ROW
EXECUTE FUNCTION normalize_stripe_system_application_lifecycle();

CREATE OR REPLACE FUNCTION retire_unconfirmed_stripe_gift_pointers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- The application writer still has the selected gift id in memory and writes
  -- the proposed ledger row later in the same transaction. Clearing the legacy
  -- columns here prevents the duplicate pointer from becoming durable state.
  IF NEW.auto_applied IS TRUE AND NEW.match_confirmed_at IS NULL THEN
    NEW.matched_gift_id := NULL;
    NEW.created_gift_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stripe_staged_charges_retire_unconfirmed_gift_pointers
  ON stripe_staged_charges;

CREATE TRIGGER stripe_staged_charges_retire_unconfirmed_gift_pointers
BEFORE INSERT OR UPDATE ON stripe_staged_charges
FOR EACH ROW
EXECUTE FUNCTION retire_unconfirmed_stripe_gift_pointers();

-- Remove the earlier AFTER-row mirror if a development database applied a draft
-- version of this migration before it was finalized.
DROP TRIGGER IF EXISTS stripe_auto_apply_payment_application_bridge
  ON stripe_staged_charges;
DROP FUNCTION IF EXISTS mirror_stripe_auto_apply_to_payment_application();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'payment_applications_normalize_stripe_system_lifecycle'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0127 failed: lifecycle normalization trigger missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'stripe_staged_charges_retire_unconfirmed_gift_pointers'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0127 failed: pointer retirement trigger missing';
  END IF;
END;
$$;

COMMIT;
