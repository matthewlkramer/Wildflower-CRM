-- 0194: payment_units.gift_id pointer + corroborating→source_links backfill
-- (docs/adr-unit-gift-pointer.md).
--
-- The tie stage of the spine chain (deposit ← bundle ← unit → gift) becomes a
-- direct backward pointer on the unit. Successor of payment_applications:
--   counted rows        → payment_units.gift_id  (one unit funds ONE gift)
--   corroborating rows  → source_links unit_gift_corroboration
-- payment_applications stays authoritative until the read cutover; this
-- migration is additive + a derived backfill, safe to re-run.
--
-- Requires 0193 (enum value) applied first.
--
-- Apply after Publish, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0194_unit_gift_pointer_columns_backfill.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

-- 1. The pointer. RESTRICT: a funded gift cannot be deleted out from under
--    its money.
ALTER TABLE payment_units
  ADD COLUMN IF NOT EXISTS gift_id text
    REFERENCES gifts_and_payments(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS payment_units_gift_id_idx
  ON payment_units (gift_id);

-- 2. Gift anchor on source_links for unit_gift_corroboration.
ALTER TABLE source_links
  ADD COLUMN IF NOT EXISTS gift_id text
    REFERENCES gifts_and_payments(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS source_links_gift_id_idx
  ON source_links (gift_id);

-- One corroboration claim per unit↔gift pair.
CREATE UNIQUE INDEX IF NOT EXISTS source_links_unit_gift_corrob_uq
  ON source_links (payment_unit_id, gift_id)
  WHERE link_type = 'unit_gift_corroboration';

-- 3. Re-pin the per-type FK shape to cover the new type (each shape also
--    asserts every non-participating anchor is NULL).
ALTER TABLE source_links DROP CONSTRAINT IF EXISTS source_links_fk_shape_chk;
ALTER TABLE source_links ADD CONSTRAINT source_links_fk_shape_chk CHECK ((
  (link_type = 'charge_qb_tie'   AND stripe_charge_id IS NOT NULL AND qb_staged_payment_id IS NOT NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL) OR
  (link_type = 'charge_fee_row'  AND stripe_charge_id IS NOT NULL AND qb_staged_payment_id IS NOT NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL) OR
  (link_type = 'donorbox_qb'     AND donorbox_donation_id IS NOT NULL AND qb_staged_payment_id IS NOT NULL AND stripe_charge_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL) OR
  (link_type = 'donorbox_charge' AND donorbox_donation_id IS NOT NULL AND stripe_charge_id IS NOT NULL AND qb_staged_payment_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL) OR
  (link_type = 'qbo_register_deposit' AND bank_transaction_id IS NOT NULL AND bank_deposit_id IS NOT NULL AND stripe_charge_id IS NULL AND qb_staged_payment_id IS NULL AND donorbox_donation_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL) OR
  (link_type = 'qbo_register_unit'    AND bank_transaction_id IS NOT NULL AND payment_unit_id IS NOT NULL AND stripe_charge_id IS NULL AND qb_staged_payment_id IS NULL AND donorbox_donation_id IS NULL AND bank_deposit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL) OR
  (link_type = 'qbo_line_deposit'     AND qb_staged_payment_id IS NOT NULL AND bank_deposit_id IS NOT NULL AND stripe_charge_id IS NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL) OR
  (link_type = 'payout_qb_settlement' AND qb_staged_payment_id IS NOT NULL AND stripe_payout_id IS NOT NULL AND stripe_charge_id IS NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND gift_id IS NULL) OR
  (link_type = 'unit_gift_corroboration' AND payment_unit_id IS NOT NULL AND gift_id IS NOT NULL AND stripe_charge_id IS NULL AND qb_staged_payment_id IS NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND stripe_payout_id IS NULL)
));

-- 4. Backfill the pointer from the counted ledger (one counted row per unit —
--    enforced by the counted-unique index — so this scalar subquery is safe).
UPDATE payment_units pu
SET gift_id = pa.gift_id
FROM payment_applications pa
WHERE pa.payment_unit_id = pu.id
  AND pa.link_role = 'counted'
  AND pu.gift_id IS DISTINCT FROM pa.gift_id;

-- 5. Backfill corroborating rows as source_links claims. Human-confirmed rows
--    keep provenance/confirmer; system rows stay provenance='system'.
INSERT INTO source_links (
  id, link_type, payment_unit_id, gift_id,
  lifecycle, provenance, confirmed_by_user_id, confirmed_at, note
)
SELECT
  'srcl_ugc_' || pa.payment_unit_id || '_' || pa.gift_id,
  'unit_gift_corroboration',
  pa.payment_unit_id,
  pa.gift_id,
  'confirmed',
  CASE pa.match_method
    WHEN 'human' THEN 'human'::source_link_provenance
    WHEN 'system_confirmed' THEN 'system_confirmed'::source_link_provenance
    ELSE 'system'::source_link_provenance
  END,
  pa.confirmed_by_user_id,
  pa.confirmed_at,
  pa.note
FROM payment_applications pa
WHERE pa.link_role = 'corroborating'
ON CONFLICT (id) DO NOTHING;
