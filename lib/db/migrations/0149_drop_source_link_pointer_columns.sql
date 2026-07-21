-- 0149: Drop the 5 deprecated cross-processor pointer columns.
--
-- The source_links ledger (migration 0128+ era, read-flipped and dual-write
-- retired) is now the SOLE authority for charge↔QB ties, charge fee rows, and
-- Donorbox↔QB/Stripe links. Drift checks against prod verified all pointer
-- mirrors agree with (or are NULL alongside) the ledger, so dropping the
-- columns loses no information.
--
-- Idempotent: safe to re-run. Applied with `psql -1` (single transaction) —
-- do NOT add BEGIN/COMMIT here.

DROP INDEX IF EXISTS stripe_staged_charges_linked_qb_staged_payment_id_idx;
DROP INDEX IF EXISTS stripe_staged_charges_proposed_qb_staged_payment_id_idx;
DROP INDEX IF EXISTS stripe_staged_charges_linked_fee_qb_staged_payment_id_uq;
DROP INDEX IF EXISTS donorbox_donations_linked_qb_staged_payment_id_idx;
DROP INDEX IF EXISTS donorbox_donations_linked_stripe_charge_id_idx;

ALTER TABLE stripe_staged_charges
  DROP COLUMN IF EXISTS linked_qb_staged_payment_id,
  DROP COLUMN IF EXISTS proposed_qb_staged_payment_id,
  DROP COLUMN IF EXISTS linked_fee_qb_staged_payment_id;

ALTER TABLE donorbox_donations
  DROP COLUMN IF EXISTS linked_qb_staged_payment_id,
  DROP COLUMN IF EXISTS linked_stripe_charge_id;
