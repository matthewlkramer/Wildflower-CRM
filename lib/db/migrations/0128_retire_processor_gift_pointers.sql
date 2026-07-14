-- 0128_retire_processor_gift_pointers.sql
--
-- Final data step for Stripe + Donorbox pointer retirement. The physical columns
-- remain for rolling-deploy compatibility, but all operational readers/writers use
-- payment_applications. This migration aborts unless every populated pointer has
-- an equivalent active ledger application, then clears the duplicate state.
--
-- Safe to run repeatedly: after the first successful run all updates are no-ops.

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
        AND pa.lifecycle = 'confirmed'
        AND pa.gift_id = COALESCE(dd.matched_gift_id, dd.created_gift_id)
        AND (
          (dd.created_gift_id IS NULL AND pa.created_the_gift IS NOT TRUE)
          OR (dd.created_gift_id IS NOT NULL AND pa.created_the_gift IS TRUE)
        )
    );

  IF donorbox_mismatch_count <> 0 THEN
    RAISE EXCEPTION
      '0128 aborted: % Donorbox gift pointer row(s) lack an equivalent confirmed payment_application',
      donorbox_mismatch_count;
  END IF;
END;
$$;

-- A row must never carry both legacy pointers. This is separately guarded so a
-- malformed row cannot be hidden by COALESCE in the parity checks above.
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
    -- approved/reconciled were relationship-derived stored states. Preserve only
    -- exclusion states; active/done now derives from payment_applications.
    status = CASE
      WHEN status IN ('approved', 'reconciled') THEN 'pending'::staged_payment_status
      ELSE status
    END,
    updated_at = now()
WHERE matched_gift_id IS NOT NULL
   OR created_gift_id IS NOT NULL
   OR status IN ('approved', 'reconciled');

-- Postcondition: no duplicate processor gift pointers remain.
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
END;
$$;

COMMIT;
