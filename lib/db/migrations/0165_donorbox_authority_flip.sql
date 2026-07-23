-- 0165: Phase 6 — make payment_units.donorbox_donation_id the single canonical
-- Donorbox authority (docs/adr-bank-spine-money-model.md). One pointer, one
-- direction (unit -> donation), UNIQUE — at most one payment per donation; a
-- donation with no unit is a completeness report, not a constraint failure.
-- No reciprocal pointer is added. Raw source ids
-- (donorbox_donations.stripe_charge_id, source_links donorbox_charge rows)
-- remain imported evidence feeding this writer; the ledger overlay is retired
-- in Phase 9.
--
-- Sets the pointer on CARD-payment units (kind = stripe_charge) from the two
-- existing evidence paths:
--   1. donorbox_donations.stripe_charge_id (sync-pulled; partial UNIQUE)
--   2. source_links donorbox_charge rows (human cross-processor ties)
-- OFFLINE-check units already carry their pointer from 0162. Finally re-runs
-- the 0164 donorbox ledger annotation, which becomes resolvable for card
-- donations once the pointer exists.
--
-- WHY SAFE: fills NULLs only, never overwrites; the partial UNIQUE on
-- payment_units.donorbox_donation_id (0160) is the cardinality backstop; the
-- NOT EXISTS guard makes a conflicting second claim a skip, not an error.
-- Idempotent / re-runnable.
--
-- APPLY ORDER: after 0162 and 0164.
--
-- Run (human, repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0165_donorbox_authority_flip.sql

-- 1) Sync-pulled charge id on the donation.
UPDATE payment_units pu
SET donorbox_donation_id = d.id, updated_at = now()
FROM donorbox_donations d
WHERE pu.donorbox_donation_id IS NULL
  AND pu.stripe_charge_id IS NOT NULL
  AND d.stripe_charge_id = pu.stripe_charge_id
  AND NOT EXISTS (SELECT 1 FROM payment_units x WHERE x.donorbox_donation_id = d.id);

-- 2) Human cross-processor ties (source_links donorbox_charge).
UPDATE payment_units pu
SET donorbox_donation_id = sl.donorbox_donation_id, updated_at = now()
FROM source_links sl
WHERE pu.donorbox_donation_id IS NULL
  AND sl.link_type = 'donorbox_charge'
  AND sl.stripe_charge_id = pu.stripe_charge_id
  AND NOT EXISTS (SELECT 1 FROM payment_units x
                  WHERE x.donorbox_donation_id = sl.donorbox_donation_id);

-- 3) Ledger annotation for donorbox-anchored rows now resolvable (re-run of
--    0164's donorbox step).
UPDATE payment_applications pa
SET payment_unit_id = pu.id, updated_at = now()
FROM payment_units pu
WHERE pa.payment_unit_id IS NULL
  AND pa.donorbox_donation_id IS NOT NULL
  AND pu.donorbox_donation_id = pa.donorbox_donation_id;
