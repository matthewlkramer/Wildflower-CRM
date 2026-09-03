-- 0195: physically retire payment_applications (docs/adr-unit-gift-pointer.md).
--
-- Read/write cutover to payment_units.gift_id (counted) and source_links
-- unit_gift_corroboration (corroborating) is complete.
--
-- Environment status verified 2026-09-02:
--   - production: table already absent (confirmed by the 2026-07-28 audit)
--   - development: empty table retired by applying this migration
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

DROP TABLE IF EXISTS payment_applications;
