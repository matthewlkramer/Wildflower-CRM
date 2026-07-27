-- 0195: physically retire payment_applications (docs/adr-unit-gift-pointer.md).
--
-- ██ DO NOT APPLY until the READ CUTOVER is complete ██
-- Every reader/writer must be on payment_units.gift_id (counted) and
-- source_links unit_gift_corroboration (corroborating) first, and 0194's
-- backfill verified for parity against the ledger. This file exists so the
-- retirement is reviewed with the same PR that introduces the successor —
-- applying it is a separate, later, human decision.
--
-- Apply ONLY after read cutover + parity verification, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0195_retire_payment_applications.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

DROP TABLE IF EXISTS payment_applications;
