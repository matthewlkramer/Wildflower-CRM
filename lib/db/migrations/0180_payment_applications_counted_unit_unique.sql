-- 0180: formalize counted payment-unit uniqueness.
--
-- Additive and idempotent. The three source-anchor counted-unique indexes
-- remain in place until the legacy anchors are retired.

CREATE UNIQUE INDEX IF NOT EXISTS payment_applications_payment_unit_id_counted_uq
  ON payment_applications (payment_unit_id)
  WHERE link_role = 'counted';
