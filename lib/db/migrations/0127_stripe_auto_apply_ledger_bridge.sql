-- Temporary compatibility bridge for the ledger-first reconciliation cutover.
--
-- Existing Stripe sync code still records a high-confidence system proposal by
-- setting stripe_staged_charges.matched_gift_id + auto_applied. Operational
-- readers now derive proposal/confirmed status from payment_applications, so
-- this trigger mirrors only that proposal state into the ledger until the sync
-- writer is changed to call proposeStripeChargeApplication directly.
--
-- This migration is intentionally narrow:
--   * only auto_applied=true, unconfirmed Stripe proposals are mirrored;
--   * confirmed/human relationships continue through application services;
--   * clearing/re-targeting the proposal removes/replaces the system proposal;
--   * confirmed counted rows are never deleted or overwritten;
--   * no production data is changed outside the touched charge.
--
-- Remove this trigger after grep confirms zero Stripe proposal pointer writes.

BEGIN;

CREATE OR REPLACE FUNCTION mirror_stripe_auto_apply_to_payment_application()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  proposal_amount numeric(14,2);
BEGIN
  -- Serialize proposal changes with the charge row update that fired us.
  proposal_amount := NEW.gross_amount;

  -- Remove stale system proposals whenever the pointer target changes, the
  -- proposal is cleared, or the charge is confirmed/reverted.
  DELETE FROM payment_applications pa
  WHERE pa.stripe_charge_id = NEW.id
    AND pa.evidence_source = 'stripe'
    AND pa.link_role = 'counted'
    AND pa.lifecycle = 'proposed'
    AND pa.match_method = 'system'
    AND (
      NEW.auto_applied IS DISTINCT FROM true
      OR NEW.match_confirmed_at IS NOT NULL
      OR NEW.matched_gift_id IS NULL
      OR pa.gift_id IS DISTINCT FROM NEW.matched_gift_id
    );

  IF NEW.auto_applied = true
     AND NEW.match_confirmed_at IS NULL
     AND NEW.matched_gift_id IS NOT NULL
     AND proposal_amount IS NOT NULL
     AND proposal_amount > 0
  THEN
    -- Never displace a confirmed relationship. The active-owner constraint in
    -- migration 0126 also backstops this invariant.
    IF EXISTS (
      SELECT 1
      FROM payment_applications pa
      WHERE pa.stripe_charge_id = NEW.id
        AND pa.evidence_source = 'stripe'
        AND pa.link_role = 'counted'
        AND pa.lifecycle = 'confirmed'
    ) THEN
      RAISE EXCEPTION
        'stripe charge % already has a confirmed payment application', NEW.id
        USING ERRCODE = '23505';
    END IF;

    INSERT INTO payment_applications (
      id,
      gift_id,
      amount_applied,
      evidence_source,
      stripe_charge_id,
      match_method,
      link_role,
      lifecycle,
      confirmed_by_user_id,
      confirmed_at,
      created_the_gift,
      created_at,
      updated_at
    ) VALUES (
      'pa_bridge_' || md5(NEW.id || ':' || NEW.matched_gift_id),
      NEW.matched_gift_id,
      proposal_amount,
      'stripe',
      NEW.id,
      'system',
      'counted',
      'proposed',
      NULL,
      NULL,
      false,
      now(),
      now()
    )
    ON CONFLICT (stripe_charge_id, gift_id)
      WHERE stripe_charge_id IS NOT NULL AND link_role = 'counted'
    DO UPDATE SET
      amount_applied = EXCLUDED.amount_applied,
      match_method = 'system',
      lifecycle = 'proposed',
      confirmed_by_user_id = NULL,
      confirmed_at = NULL,
      created_the_gift = false,
      updated_at = now()
    WHERE payment_applications.lifecycle = 'proposed'
      AND payment_applications.match_method = 'system';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stripe_auto_apply_payment_application_bridge
  ON stripe_staged_charges;

CREATE TRIGGER stripe_auto_apply_payment_application_bridge
AFTER INSERT OR UPDATE OF
  matched_gift_id,
  auto_applied,
  match_confirmed_at,
  gross_amount
ON stripe_staged_charges
FOR EACH ROW
EXECUTE FUNCTION mirror_stripe_auto_apply_to_payment_application();

COMMIT;
