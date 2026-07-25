-- 0184: add direct-component exclusion facts.
--
-- Additive only. Direct check/ACH/wire components now mirror the existing
-- staged-payment and Stripe-charge exclusion pattern. A nullable reason means
-- the component is still included; classification_source='manual' records a
-- human exclusion/re-inclusion pin. Existing deposit-level exclusions and all
-- existing component rows remain unchanged.
--
-- Apply (human-gated, after Publish):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0184_bank_deposit_component_exclusions.sql
--
-- Do not add BEGIN/COMMIT: callers use psql -1.

ALTER TABLE bank_deposit_components
  ADD COLUMN IF NOT EXISTS exclusion_reason staged_payment_exclusion_reason;

ALTER TABLE bank_deposit_components
  ADD COLUMN IF NOT EXISTS classification_source staged_payment_classification_source
  NOT NULL DEFAULT 'auto';
