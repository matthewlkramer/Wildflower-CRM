-- 0125_payment_application_settlement_supersede.sql
--
-- Add durable provenance for QBO applications temporarily demoted from counted
-- to corroborating because a confirmed Stripe payout settlement supplies the
-- donor-level counted applications for the same dollars.
--
-- The value intentionally is not a foreign key. It must survive deletion or
-- replacement of a settlement link long enough for the bidirectional recompute
-- to promote the QBO application back to counted. The application service clears
-- it after promotion or replaces it with the currently owning settlement link.

BEGIN;

ALTER TABLE payment_applications
  ADD COLUMN IF NOT EXISTS superseded_by_settlement_link_id text;

CREATE INDEX IF NOT EXISTS payment_applications_superseded_by_settlement_link_id_idx
  ON payment_applications (superseded_by_settlement_link_id)
  WHERE superseded_by_settlement_link_id IS NOT NULL;

COMMENT ON COLUMN payment_applications.superseded_by_settlement_link_id IS
  'Non-null only when settlement supersession demoted a confirmed counted QBO application to corroborating. Cleared when the application is promoted back to counted.';

COMMIT;
