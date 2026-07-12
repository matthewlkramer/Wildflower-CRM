-- 0114: Charge-grain Stripe↔QuickBooks tie PROPOSALS (Task: match
-- individually-booked payouts in the settlement report).
--
-- Adds stripe_staged_charges.proposed_qb_staged_payment_id — a SYSTEM-PROPOSED
-- (not yet confirmed) tie from one Stripe charge to the QuickBooks
-- staged_payments row that records the SAME money, for payouts the bookkeeper
-- booked as individual QB rows instead of one deposit lump. A human approve on
-- the Settlement report moves the proposal into the existing confirmed
-- `linked_qb_staged_payment_id` (+ provenance columns) and clears it.
--
-- Additive and idempotent; safe to re-run. No data backfill: proposals are
-- recomputed on demand by the charge-grain proposal pass (admin
-- "Propose historical matches" / incremental sync).
-- Apply (from the repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0114_charge_qb_tie_proposals.sql

ALTER TABLE stripe_staged_charges
  ADD COLUMN IF NOT EXISTS proposed_qb_staged_payment_id text
    REFERENCES staged_payments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS stripe_staged_charges_proposed_qb_staged_payment_id_idx
  ON stripe_staged_charges (proposed_qb_staged_payment_id);
