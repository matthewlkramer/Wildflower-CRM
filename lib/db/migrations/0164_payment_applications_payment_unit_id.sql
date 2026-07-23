-- 0164: Phase 5a — add the successor anchor to the cash-application ledger
-- (docs/adr-bank-spine-money-model.md). payment_applications.payment_unit_id
-- points at the canonical payment_units row; the three source anchors
-- (payment_id / stripe_charge_id / donorbox_donation_id) demote to provenance
-- at read cutover, collapsing the three counted-unique indexes to ONE.
--
-- DELIBERATELY NOT UNIQUE YET: two legacy counted rows can describe the SAME
-- unit (e.g. a quickbooks row and the donorbox row for one offline check).
-- Consolidating those to one counted row per unit is the human-gated cutover
-- step, verified by parity queries first — this migration only ANNOTATES.
--
-- Backfill mapping (deterministic, per anchor):
--   stripe    → pu_<stripe_charge_id>            (0160; exists iff non-excluded)
--   quickbooks→ pu_<payment_id>                  (0162; exists iff deposit-composing)
--   donorbox  → payment_units.donorbox_donation_id = anchor (offline units from
--               0162 now; card units gain the pointer in Phase 6 — re-run then)
--
-- APPLY ORDER: after 0160 and 0162. Idempotent + re-runnable (only fills NULLs;
-- re-running after Phase 6 fills the then-resolvable donorbox rows).
--
-- Run (human, repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0164_payment_applications_payment_unit_id.sql

ALTER TABLE payment_applications
  ADD COLUMN IF NOT EXISTS payment_unit_id text
    REFERENCES payment_units(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS payment_applications_payment_unit_id_idx
  ON payment_applications (payment_unit_id);

-- stripe anchor → the charge's unit.
UPDATE payment_applications pa
SET payment_unit_id = pu.id, updated_at = now()
FROM payment_units pu
WHERE pa.payment_unit_id IS NULL
  AND pa.stripe_charge_id IS NOT NULL
  AND pu.stripe_charge_id = pa.stripe_charge_id;

-- quickbooks anchor → the deposit-composing row's check unit (when one exists).
UPDATE payment_applications pa
SET payment_unit_id = pu.id, updated_at = now()
FROM payment_units pu
WHERE pa.payment_unit_id IS NULL
  AND pa.payment_id IS NOT NULL
  AND pu.source_staged_payment_id = pa.payment_id;

-- donorbox anchor → the unit carrying the donation pointer.
UPDATE payment_applications pa
SET payment_unit_id = pu.id, updated_at = now()
FROM payment_units pu
WHERE pa.payment_unit_id IS NULL
  AND pa.donorbox_donation_id IS NOT NULL
  AND pu.donorbox_donation_id = pa.donorbox_donation_id;
