-- 0202: add source_link_match_basis value 'supersede_demotion'.
--
-- Write-retirement step 2 (unit→gift write cutover): charge-tie / settlement
-- supersede demotions stop writing corroborating payment_applications rows and
-- instead record a unit_gift_corroboration source_link crumb discriminated by
-- match_basis = 'supersede_demotion'. `provenance` carries the demoted tie's
-- original match method; confirmed_by_user_id / confirmed_at carry its
-- confirmation stamp, so a tie revert can promote the booking back losslessly.
--
-- ADD VALUE cannot run inside a transaction block — run this file with
-- autocommit (no -1 flag):
--   psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0202_source_link_match_basis_supersede_demotion.sql
--
-- Idempotent: IF NOT EXISTS.

ALTER TYPE source_link_match_basis ADD VALUE IF NOT EXISTS 'supersede_demotion';
