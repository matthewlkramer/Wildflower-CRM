-- 0181: retire the redundant legacy-anchor counted uniqueness indexes.
--
-- The counted payment-unit uniqueness index from 0180 is now the sole
-- counted-row arbiter. The legacy anchor columns and their CHECK constraints
-- remain because backward-compatible writers still populate them.

DROP INDEX IF EXISTS payment_applications_payment_id_counted_uq;
DROP INDEX IF EXISTS payment_applications_stripe_charge_id_counted_uq;
DROP INDEX IF EXISTS payment_applications_donorbox_donation_id_counted_uq;
