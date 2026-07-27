-- 0198: gift_allocation_id anchor on source_links + qbo_line_allocation shape
-- (docs/adr-qbo-evidence-grain.md).
--
-- Requires 0197 (enum value) applied first — an enum value cannot be
-- referenced in the same transaction that adds it.
--
-- Apply after Publish, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0198_source_link_allocation_grain_column.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

ALTER TABLE source_links
  ADD COLUMN IF NOT EXISTS gift_allocation_id text
    REFERENCES gift_allocations(id) ON DELETE CASCADE;

-- Re-pin the per-type FK shape to cover qbo_line_allocation (every other
-- shape also asserts gift_allocation_id IS NULL).
ALTER TABLE source_links DROP CONSTRAINT IF EXISTS source_links_fk_shape_chk;
ALTER TABLE source_links ADD CONSTRAINT source_links_fk_shape_chk CHECK ((
  (link_type = 'charge_qb_tie'   AND stripe_charge_id IS NOT NULL AND qb_staged_payment_id IS NOT NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL AND gift_allocation_id IS NULL) OR
  (link_type = 'charge_fee_row'  AND stripe_charge_id IS NOT NULL AND qb_staged_payment_id IS NOT NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL AND gift_allocation_id IS NULL) OR
  (link_type = 'donorbox_qb'     AND donorbox_donation_id IS NOT NULL AND qb_staged_payment_id IS NOT NULL AND stripe_charge_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL AND gift_allocation_id IS NULL) OR
  (link_type = 'donorbox_charge' AND donorbox_donation_id IS NOT NULL AND stripe_charge_id IS NOT NULL AND qb_staged_payment_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL AND gift_allocation_id IS NULL) OR
  (link_type = 'qbo_register_deposit' AND bank_transaction_id IS NOT NULL AND bank_deposit_id IS NOT NULL AND stripe_charge_id IS NULL AND qb_staged_payment_id IS NULL AND donorbox_donation_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL AND gift_allocation_id IS NULL) OR
  (link_type = 'qbo_register_unit'    AND bank_transaction_id IS NOT NULL AND payment_unit_id IS NOT NULL AND stripe_charge_id IS NULL AND qb_staged_payment_id IS NULL AND donorbox_donation_id IS NULL AND bank_deposit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL AND gift_allocation_id IS NULL) OR
  (link_type = 'qbo_line_deposit'     AND qb_staged_payment_id IS NOT NULL AND bank_deposit_id IS NOT NULL AND stripe_charge_id IS NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL AND gift_allocation_id IS NULL) OR
  (link_type = 'payout_qb_settlement' AND qb_staged_payment_id IS NOT NULL AND stripe_payout_id IS NOT NULL AND stripe_charge_id IS NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND gift_id IS NULL AND gift_allocation_id IS NULL) OR
  (link_type = 'unit_gift_corroboration' AND payment_unit_id IS NOT NULL AND gift_id IS NOT NULL AND stripe_charge_id IS NULL AND qb_staged_payment_id IS NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND stripe_payout_id IS NULL AND gift_allocation_id IS NULL) OR
  (link_type = 'qbo_line_allocation'  AND qb_staged_payment_id IS NOT NULL AND gift_allocation_id IS NOT NULL AND stripe_charge_id IS NULL AND donorbox_donation_id IS NULL AND bank_transaction_id IS NULL AND bank_deposit_id IS NULL AND payment_unit_id IS NULL AND stripe_payout_id IS NULL AND gift_id IS NULL)
));

-- One claim per (line, allocation) pair. A line may evidence several
-- allocations (a 650k line booked against 600k+50k allocations) and an
-- allocation may be evidenced by several lines (150k+850k lines against a 1M
-- allocation) — no single-sided uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS source_links_line_allocation_uq
  ON source_links (qb_staged_payment_id, gift_allocation_id)
  WHERE link_type = 'qbo_line_allocation';

CREATE INDEX IF NOT EXISTS source_links_gift_allocation_id_idx
  ON source_links (gift_allocation_id);
