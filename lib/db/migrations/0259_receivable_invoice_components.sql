-- 0259: preserve invoice applications and invoice-grain deposit components.
-- ADD VALUE must run outside an explicit transaction block.

ALTER TYPE staged_payment_exclusion_reason
  ADD VALUE IF NOT EXISTS 'lease_guaranty';

ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS qb_invoice_applications jsonb;

ALTER TABLE bank_deposit_components
  ADD COLUMN IF NOT EXISTS source_invoice_id text;

CREATE UNIQUE INDEX IF NOT EXISTS bank_deposit_components_source_invoice_uq
  ON bank_deposit_components (source_staged_payment_id, source_invoice_id)
  WHERE source_staged_payment_id IS NOT NULL
    AND source_invoice_id IS NOT NULL;
