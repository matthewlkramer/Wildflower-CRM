-- 0203: discriminate supersede-managed demotion crumbs on source_links.
--
-- Write-retirement step 2 (unit→gift write cutover). The 0194 backfill copied
-- EVERY corroborating payment_applications row into a unit_gift_corroboration
-- source_link, but left the two kinds indistinguishable:
--   • corrections-flow annotations (amount_applied IS NULL) — plain evidence;
--   • supersede-managed demotion crumbs (amount_applied IS NOT NULL) — a
--     charge-tie / settlement supersede demoted the counted booking and must
--     be able to PROMOTE it back on revert.
-- The retired ledger discriminated by amount; the successor discriminator is
-- match_basis = 'supersede_demotion' (added by 0202). provenance already
-- carries the demoted tie's original match method (0194 mapped it), and
-- confirmed_by_user_id / confirmed_at its confirmation stamp.
--
-- Requires 0202 (enum value) applied first.
--
-- Apply after Publish, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0203_supersede_demotion_crumb_backfill.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1. Idempotent.

-- 1. Upsert a crumb for every supersede-managed corroborating ledger row
--    (covers rows demoted after 0194 ran, and re-stamps the basis on the
--    0194-backfilled ones).
INSERT INTO source_links (
  id, link_type, payment_unit_id, gift_id,
  lifecycle, provenance, match_basis,
  confirmed_by_user_id, confirmed_at, note
)
SELECT
  'srcl_ugc_' || pa.payment_unit_id || '_' || pa.gift_id,
  'unit_gift_corroboration',
  pa.payment_unit_id,
  pa.gift_id,
  'confirmed',
  CASE pa.match_method
    WHEN 'human' THEN 'human'::source_link_provenance
    WHEN 'system_confirmed' THEN 'system_confirmed'::source_link_provenance
    ELSE 'system'::source_link_provenance
  END,
  'supersede_demotion'::source_link_match_basis,
  pa.confirmed_by_user_id,
  pa.confirmed_at,
  pa.note
FROM payment_applications pa
WHERE pa.link_role = 'corroborating'
  AND pa.amount_applied IS NOT NULL
ON CONFLICT (id) DO UPDATE SET
  match_basis = EXCLUDED.match_basis,
  provenance = EXCLUDED.provenance,
  confirmed_by_user_id = EXCLUDED.confirmed_by_user_id,
  confirmed_at = EXCLUDED.confirmed_at,
  updated_at = now();

-- 2. Postcondition: every supersede-managed ledger crumb has a discriminated
--    source_link.
DO $$
DECLARE missing int;
BEGIN
  SELECT COUNT(*) INTO missing
  FROM payment_applications pa
  WHERE pa.link_role = 'corroborating'
    AND pa.amount_applied IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM source_links srcl
      WHERE srcl.link_type = 'unit_gift_corroboration'
        AND srcl.payment_unit_id = pa.payment_unit_id
        AND srcl.gift_id = pa.gift_id
        AND srcl.match_basis = 'supersede_demotion'
    );
  IF missing > 0 THEN
    RAISE EXCEPTION '0203 postcondition failed: % supersede crumbs missing a discriminated source_link', missing;
  END IF;
END $$;
