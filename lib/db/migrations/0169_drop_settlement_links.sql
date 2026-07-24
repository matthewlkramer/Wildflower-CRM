-- 0169: retire the settlement_links workflow table (bank-spine ADR Phase 9).
--
-- The payout ↔ QBO-lump relationship is now the plain pairing fact
-- staged_payments.settled_stripe_payout_id (0168), backfilled from every
-- human-confirmed settlement link before this drop. The propose/confirm/
-- revert lifecycle, exempt withdrawal links, and conflict gifts have no
-- successor: pairing is deterministic (exact amount in the bank window),
-- withdrawal exemption derives from the negative payout amount, and
-- expected-vs-actual discrepancies surface in qbo_accounting_checks.
--
-- APPLY ONLY AFTER the release that removes all application references to
-- settlement_links is deployed. Idempotent; safe to re-run.

DROP TABLE IF EXISTS settlement_links;

DROP TYPE IF EXISTS settlement_link_lifecycle;
DROP TYPE IF EXISTS settlement_link_provenance;
