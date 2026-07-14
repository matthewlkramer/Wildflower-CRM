-- 0128_retire_processor_gift_pointers.sql
--
-- Final data and enforcement step for Stripe + Donorbox gift-pointer retirement.
-- The physical columns remain temporarily for rolling-deploy compatibility, but
-- payment_applications is authoritative. This migration:
--   1. aborts unless every populated pointer has an equivalent active ledger row;
--   2. clears the duplicate pointer state; and
--   3. installs transition guards so an older application process cannot make a
--      pointer durable after the cutover.
--
-- Safe to run repeatedly.

BEGIN;

DO $$
DECLARE
  stripe_mismatch_count integer;
  donorbox_mismatch_count integer;
BEGIN
  SELECT count(*)::int
  INTO stripe_mismatch_count
  FROM stripe_staged_charges sc
  WHERE (sc.matched_gift_id IS NOT NULL OR sc.created_gift_id IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1
      FROM payment_applications pa
      WHERE pa.stripe_charge_id = sc.id
        AND pa.evidence_source = 'stripe'
        AND pa.link_role = 'counted'
        AND pa.lifecycle IN ('proposed', 'confirmed')
        AND pa.gift_id = COALESCE(sc.matched_gift_id, sc.created_gift_id)
        AND (
          (sc.created_gift_id IS NULL AND pa.created_the_gift IS NOT TRUE)
          OR (sc.created_gift_id IS NOT NULL AND pa.created_the_gift IS TRUE)
        )
    );

  IF stripe_mismatch_count <> 0 THEN
    RAISE EXCEPTION
      '0128 aborted: % Stripe gift pointer row(s) lack an equivalent active payment_application',
      stripe_mismatch_count;
  END IF;

  SELECT count(*)::int
  INTO donorbox_mismatch_count
  FROM donorbox_donations dd
  WHERE (dd.matched_gift_id IS NOT NULL OR dd.created_gift_id IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1
      FROM payment_applications pa
      WHERE pa.donorbox_donation_id = dd.id
        AND pa.evidence_source = 'donorbox'
        AND pa.link_role = 'counted'
        AND pa.lifecycle IN ('proposed', 'confirmed')
        AND pa.gift_id = COALESCE(dd.matched_gift_id, dd.created_gift_id)
        AND (
          (dd.created_gift_id IS NULL AND pa.created_the_gift IS NOT TRUE)
          OR (dd.created_gift_id IS NOT NULL AND pa.created_the_gift IS TRUE)
        )
    );

  IF donorbox_mismatch_count <> 0 THEN
    RAISE EXCEPTION
      '0128 aborted: % Donorbox gift pointer row(s) lack an equivalent active payment_application',
      donorbox_mismatch_count;
  END IF;
END;
$$;

DO $$
DECLARE
  dual_pointer_count integer;
BEGIN
  SELECT (
    (SELECT count(*) FROM stripe_staged_charges
      WHERE matched_gift_id IS NOT NULL AND created_gift_id IS NOT NULL)
    +
    (SELECT count(*) FROM donorbox_donations
      WHERE matched_gift_id IS NOT NULL AND created_gift_id IS NOT NULL)
  )::int
  INTO dual_pointer_count;

  IF dual_pointer_count <> 0 THEN
    RAISE EXCEPTION
      '0128 aborted: % processor row(s) carry both matched_gift_id and created_gift_id',
      dual_pointer_count;
  END IF;
END;
$$;

UPDATE stripe_staged_charges
SET matched_gift_id = NULL,
    created_gift_id = NULL,
    updated_at = now()
WHERE matched_gift_id IS NOT NULL
   OR created_gift_id IS NOT NULL;

UPDATE donorbox_donations
SET matched_gift_id = NULL,
    created_gift_id = NULL,
    -- approved/reconciled were stored relationship states. Operational status now
    -- derives from payment_applications, so normalize them without touching real
    -- exclusion/rejection classifications.
    status = CASE
      WHEN status IN ('approved', 'reconciled') THEN 'pending'::staged_payment_status
      ELSE status
    END,
    updated_at = now()
WHERE matched_gift_id IS NOT NULL
   OR created_gift_id IS NOT NULL
   OR status IN ('approved', 'reconciled');

-- When a legacy writer updates the pointer before inserting its application, the
-- application trigger below clears it after the ledger write. When a legacy
-- writer tries to update a pointer after an application already exists, these
-- BEFORE triggers suppress it immediately. Together they cover either write order
-- during a rolling deployment.
CREATE OR REPLACE FUNCTION suppress_retired_processor_gift_pointer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'stripe_staged_charges' THEN
    IF (NEW.matched_gift_id IS NOT NULL OR NEW.created_gift_id IS NOT NULL)
       AND EXISTS (
         SELECT 1 FROM payment_applications pa
         WHERE pa.stripe_charge_id = NEW.id
           AND pa.evidence_source = 'stripe'
           AND pa.link_role = 'counted'
           AND pa.lifecycle IN ('proposed', 'confirmed')
       ) THEN
      NEW.matched_gift_id := NULL;
      NEW.created_gift_id := NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'donorbox_donations' THEN
    IF (NEW.matched_gift_id IS NOT NULL OR NEW.created_gift_id IS NOT NULL)
       AND EXISTS (
         SELECT 1 FROM payment_applications pa
         WHERE pa.donorbox_donation_id = NEW.id
           AND pa.evidence_source = 'donorbox'
           AND pa.link_role = 'counted'
           AND pa.lifecycle IN ('proposed', 'confirmed')
       ) THEN
      NEW.matched_gift_id := NULL;
      NEW.created_gift_id := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stripe_suppress_retired_gift_pointer
  ON stripe_staged_charges;
CREATE TRIGGER stripe_suppress_retired_gift_pointer
BEFORE INSERT OR UPDATE OF matched_gift_id, created_gift_id
ON stripe_staged_charges
FOR EACH ROW
EXECUTE FUNCTION suppress_retired_processor_gift_pointer();

DROP TRIGGER IF EXISTS donorbox_suppress_retired_gift_pointer
  ON donorbox_donations;
CREATE TRIGGER donorbox_suppress_retired_gift_pointer
BEFORE INSERT OR UPDATE OF matched_gift_id, created_gift_id
ON donorbox_donations
FOR EACH ROW
EXECUTE FUNCTION suppress_retired_processor_gift_pointer();

CREATE OR REPLACE FUNCTION clear_retired_processor_gift_pointer_from_application()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.link_role = 'counted'
     AND NEW.lifecycle IN ('proposed', 'confirmed') THEN
    IF NEW.evidence_source = 'stripe' AND NEW.stripe_charge_id IS NOT NULL THEN
      UPDATE stripe_staged_charges
      SET matched_gift_id = NULL,
          created_gift_id = NULL,
          updated_at = now()
      WHERE id = NEW.stripe_charge_id
        AND (matched_gift_id IS NOT NULL OR created_gift_id IS NOT NULL);
    ELSIF NEW.evidence_source = 'donorbox'
          AND NEW.donorbox_donation_id IS NOT NULL THEN
      UPDATE donorbox_donations
      SET matched_gift_id = NULL,
          created_gift_id = NULL,
          status = CASE
            WHEN status IN ('approved', 'reconciled')
              THEN 'pending'::staged_payment_status
            ELSE status
          END,
          updated_at = now()
      WHERE id = NEW.donorbox_donation_id
        AND (
          matched_gift_id IS NOT NULL
          OR created_gift_id IS NOT NULL
          OR status IN ('approved', 'reconciled')
        );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_application_clear_retired_processor_pointer
  ON payment_applications;
CREATE TRIGGER payment_application_clear_retired_processor_pointer
AFTER INSERT OR UPDATE OF
  gift_id,
  evidence_source,
  stripe_charge_id,
  donorbox_donation_id,
  link_role,
  lifecycle
ON payment_applications
FOR EACH ROW
EXECUTE FUNCTION clear_retired_processor_gift_pointer_from_application();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM stripe_staged_charges
    WHERE matched_gift_id IS NOT NULL OR created_gift_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM donorbox_donations
    WHERE matched_gift_id IS NOT NULL OR created_gift_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0128 failed: processor gift pointers remain after cleanup';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'payment_application_clear_retired_processor_pointer'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0128 failed: application pointer-clear trigger missing';
  END IF;
END;
$$;

COMMIT;
