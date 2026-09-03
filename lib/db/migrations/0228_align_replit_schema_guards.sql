-- 0228: align development and production schema guards before publishing.
--
-- Replit generates production migrations by comparing the live development
-- and production databases. Historical database creation paths left a set of
-- equivalent foreign keys with different names, while two cleanup_queue
-- checks, one index, and the time-zone type of a resolution timestamp existed
-- only in production. That drift made a normal publish propose dropping real
-- guards and rebuilding otherwise identical foreign keys.
--
-- This migration is deliberately idempotent in both environments:
--   * development renames equivalent generated foreign keys to the existing
--     production names and restores the missing guards/type;
--   * production already has the canonical state, so every block is a no-op.
--
-- Do not add BEGIN/COMMIT: run with psql -1.

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT *
    FROM (VALUES
      ('people', 'people_primary_household_id_households_id_fk', 'people_primary_household_id_fkey'),
      ('stripe_payouts', 'stripe_payouts_bank_deposit_id_bank_deposits_id_fk', 'stripe_payouts_bank_deposit_id_fkey'),
      ('bank_deposits', 'bank_deposits_source_bank_transaction_id_bank_transactions_id_f', 'bank_deposits_source_bank_transaction_id_fkey'),
      ('payment_units', 'payment_units_donorbox_donation_id_donorbox_donations_id_fk', 'payment_units_donorbox_donation_id_fkey'),
      ('payment_units', 'payment_units_gift_allocation_id_gift_allocations_id_fk', 'payment_units_gift_allocation_id_fkey'),
      ('payment_units', 'payment_units_gift_confirmed_by_user_id_users_id_fk', 'payment_units_gift_confirmed_by_user_id_fkey'),
      ('payment_units', 'payment_units_gift_id_gifts_and_payments_id_fk', 'payment_units_gift_id_fkey'),
      ('payment_units', 'payment_units_source_staged_payment_id_staged_payments_id_fk', 'payment_units_source_staged_payment_id_fkey'),
      ('payment_units', 'payment_units_stripe_charge_id_stripe_staged_charges_id_fk', 'payment_units_stripe_charge_id_fkey'),
      ('qbo_accounting_checks', 'qbo_accounting_checks_resolved_by_user_id_users_id_fk', 'qbo_accounting_checks_resolved_by_user_id_fkey'),
      ('qbo_accounting_checks', 'qbo_accounting_checks_staged_payment_id_staged_payments_id_fk', 'qbo_accounting_checks_staged_payment_id_fkey'),
      ('bank_deposit_components', 'bank_deposit_components_bank_deposit_id_bank_deposits_id_fk', 'bank_deposit_components_bank_deposit_id_fkey'),
      ('bank_deposit_components', 'bank_deposit_components_payment_unit_id_payment_units_id_fk', 'bank_deposit_components_payment_unit_id_fkey'),
      ('bank_deposit_components', 'bank_deposit_components_source_staged_payment_id_staged_payment', 'bank_deposit_components_source_staged_payment_id_fkey'),
      ('bank_deposit_exclusions', 'bank_deposit_exclusions_bank_deposit_id_bank_deposits_id_fk', 'bank_deposit_exclusions_bank_deposit_id_fkey'),
      ('bank_deposit_exclusions', 'bank_deposit_exclusions_created_by_user_id_users_id_fk', 'bank_deposit_exclusions_created_by_user_id_fkey'),
      ('source_links', 'source_links_bank_deposit_id_bank_deposits_id_fk', 'source_links_bank_deposit_id_fkey'),
      ('source_links', 'source_links_bank_transaction_id_bank_transactions_id_fk', 'source_links_bank_transaction_id_fkey'),
      ('source_links', 'source_links_gift_allocation_id_gift_allocations_id_fk', 'source_links_gift_allocation_id_fkey'),
      ('source_links', 'source_links_gift_id_gifts_and_payments_id_fk', 'source_links_gift_id_fkey'),
      ('source_links', 'source_links_payment_unit_id_payment_units_id_fk', 'source_links_payment_unit_id_fkey'),
      ('source_links', 'source_links_stripe_payout_id_stripe_payouts_id_fk', 'source_links_stripe_payout_id_fkey'),
      ('app_feedback', 'app_feedback_created_by_user_id_users_id_fk', 'app_feedback_created_by_user_id_fkey'),
      ('app_feedback', 'app_feedback_resolved_by_user_id_users_id_fk', 'app_feedback_resolved_by_user_id_fkey'),
      ('email_tracking_resolutions', 'email_tracking_resolutions_mailbox_user_id_users_id_fk', 'email_tracking_resolutions_mailbox_user_id_fkey'),
      ('email_tracking_resolutions', 'email_tracking_resolutions_resolved_by_user_id_users_id_fk', 'email_tracking_resolutions_resolved_by_user_id_fkey'),
      ('donor_routing_preferences', 'donor_routing_preferences_source_household_id_households_id_fk', 'donor_routing_preferences_source_household_id_fkey'),
      ('donor_routing_preferences', 'donor_routing_preferences_source_organization_id_organizations_', 'donor_routing_preferences_source_organization_id_fkey'),
      ('donor_routing_preferences', 'donor_routing_preferences_source_person_id_people_id_fk', 'donor_routing_preferences_source_person_id_fkey'),
      ('donor_routing_preferences', 'donor_routing_preferences_target_household_id_households_id_fk', 'donor_routing_preferences_target_household_id_fkey'),
      ('donor_routing_preferences', 'donor_routing_preferences_target_organization_id_organizations_', 'donor_routing_preferences_target_organization_id_fkey'),
      ('donor_routing_preferences', 'donor_routing_preferences_target_person_id_people_id_fk', 'donor_routing_preferences_target_person_id_fkey'),
      ('donor_routing_preferences', 'donor_routing_preferences_updated_by_user_id_users_id_fk', 'donor_routing_preferences_updated_by_user_id_fkey')
    ) AS names(table_name, generated_name, canonical_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = item.table_name
        AND c.conname = item.generated_name
    ) AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = item.table_name
        AND c.conname = item.canonical_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
        item.table_name,
        item.generated_name,
        item.canonical_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cleanup_queue'::regclass
      AND conname = 'cleanup_queue_proposal_kind_ck'
  ) THEN
    ALTER TABLE public.cleanup_queue
      ADD CONSTRAINT cleanup_queue_proposal_kind_ck CHECK (
        proposal_kind IS NULL OR proposal_kind IN ('gift_donor', 'default_intermediary')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cleanup_queue'::regclass
      AND conname = 'cleanup_queue_proposal_confidence_ck'
  ) THEN
    ALTER TABLE public.cleanup_queue
      ADD CONSTRAINT cleanup_queue_proposal_confidence_ck CHECK (
        proposal_confidence IS NULL OR proposal_confidence IN ('high', 'medium', 'low')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS cleanup_queue_flagged_by_user_idx
  ON public.cleanup_queue(flagged_by_user_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'email_tracking_resolutions'
      AND column_name = 'resolved_at'
      AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE public.email_tracking_resolutions
      ALTER COLUMN resolved_at TYPE timestamptz
      USING resolved_at AT TIME ZONE 'UTC';
  END IF;
END $$;
