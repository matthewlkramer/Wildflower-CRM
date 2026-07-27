-- 0190: QBO-grain anchors on source_links (docs/adr-qbo-evidence-grain.md).
--
-- source_links becomes the SOLE tie mechanism from QBO evidence (register
-- postings, QBO Deposit lines, booked lumps) to spine nodes (bank deposits,
-- payment units, Stripe payouts). Successor of:
--   bank_deposit_qbo_register            → qbo_register_deposit
--   deposit_qbo_components               → qbo_line_deposit
--   staged_payments.settled_stripe_payout_id → payout_qb_settlement
--
-- Requires 0189 (enum values) applied first.
--
-- Apply after Publish, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0190_source_link_qbo_grain_columns.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

ALTER TABLE source_links
  ADD COLUMN IF NOT EXISTS bank_transaction_id text
    REFERENCES bank_transactions(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS bank_deposit_id text
    REFERENCES bank_deposits(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS payment_unit_id text
    REFERENCES payment_units(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS stripe_payout_id text
    REFERENCES stripe_payouts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS match_basis source_link_match_basis;

-- Re-pin the per-type FK shape to cover the new link types (each shape also
-- asserts every non-participating anchor is NULL).
ALTER TABLE source_links DROP CONSTRAINT IF EXISTS source_links_fk_shape_chk;
ALTER TABLE source_links ADD CONSTRAINT source_links_fk_shape_chk CHECK ((
  (link_type = 'charge_qb_tie'   AND stripe_charge_id IS NOT NULL AND qb_staged_payment_id IS NOT NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL) OR
  (link_type = 'charge_fee_row'  AND stripe_charge_id IS NOT NULL AND qb_staged_payment_id IS NOT NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL) OR
  (link_type = 'donorbox_qb'     AND donorbox_donation_id IS NOT NULL AND qb_staged_payment_id IS NOT NULL AND stripe_charge_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL) OR
  (link_type = 'donorbox_charge' AND donorbox_donation_id IS NOT NULL AND stripe_charge_id IS NOT NULL AND qb_staged_payment_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL) OR
  (link_type = 'qbo_register_deposit' AND bank_transaction_id IS NOT NULL AND bank_deposit_id IS NOT NULL AND stripe_charge_id IS NULL AND qb_staged_payment_id IS NULL AND donorbox_donation_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL) OR
  (link_type = 'qbo_register_unit'    AND bank_transaction_id IS NOT NULL AND payment_unit_id IS NOT NULL AND stripe_charge_id IS NULL AND qb_staged_payment_id IS NULL AND donorbox_donation_id IS NULL AND bank_deposit_id IS NULL AND stripe_payout_id IS NULL) OR
  (link_type = 'qbo_line_deposit'     AND qb_staged_payment_id IS NOT NULL AND bank_deposit_id IS NOT NULL AND stripe_charge_id IS NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL) OR
  (link_type = 'payout_qb_settlement' AND qb_staged_payment_id IS NOT NULL AND stripe_payout_id IS NOT NULL AND stripe_charge_id IS NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL)
));

-- Register claims may be system-proposed (ambiguous candidates awaiting a
-- human), like charge ties; everything else stays confirmed-only.
ALTER TABLE source_links DROP CONSTRAINT IF EXISTS source_links_proposed_tie_only_chk;
ALTER TABLE source_links ADD CONSTRAINT source_links_proposed_tie_only_chk CHECK (
  lifecycle = 'confirmed' OR link_type IN ('charge_qb_tie', 'qbo_register_deposit', 'qbo_register_unit')
);

-- Cardinality: one deposit claim / one unit claim per register row (a deposit
-- may be claimed by MANY register rows — no deposit-side uniqueness); one
-- deposit claim per QBO Deposit line; payout settlement 1:1 on both sides.
CREATE UNIQUE INDEX IF NOT EXISTS source_links_register_deposit_bt_uq
  ON source_links(bank_transaction_id) WHERE link_type = 'qbo_register_deposit';
CREATE UNIQUE INDEX IF NOT EXISTS source_links_register_unit_bt_uq
  ON source_links(bank_transaction_id) WHERE link_type = 'qbo_register_unit';
CREATE UNIQUE INDEX IF NOT EXISTS source_links_qbo_line_deposit_sp_uq
  ON source_links(qb_staged_payment_id) WHERE link_type = 'qbo_line_deposit';
CREATE UNIQUE INDEX IF NOT EXISTS source_links_payout_settlement_payout_uq
  ON source_links(stripe_payout_id) WHERE link_type = 'payout_qb_settlement';
CREATE UNIQUE INDEX IF NOT EXISTS source_links_payout_settlement_qb_uq
  ON source_links(qb_staged_payment_id) WHERE link_type = 'payout_qb_settlement';

CREATE INDEX IF NOT EXISTS source_links_bank_transaction_id_idx
  ON source_links(bank_transaction_id);
CREATE INDEX IF NOT EXISTS source_links_bank_deposit_id_idx
  ON source_links(bank_deposit_id);
CREATE INDEX IF NOT EXISTS source_links_payment_unit_id_idx
  ON source_links(payment_unit_id);
CREATE INDEX IF NOT EXISTS source_links_stripe_payout_id_idx
  ON source_links(stripe_payout_id);
