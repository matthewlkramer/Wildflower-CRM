-- Migration 0059: Mark named fund entities as fiscally sponsored
--
-- Sets entities.fiscally_sponsored = true for the three fiscally sponsored
-- fund entities: Embracing Equity, Rising Tide, and Tierra Indigena.
--
-- This is a VISIBLE FLAG ONLY on the entity record. It does NOT drive coding
-- rules, analytics, or reconciliation behavior — see task scope. (The separate
-- QuickBooks `fiscally_sponsored` staged-payment EXCLUSION reason is unrelated
-- and untouched here.)
--
-- PREREQUISITE: the `fiscally_sponsored` column must already exist on `entities`
-- (it ships via the normal Publish schema diff). If the column is missing, run
-- Publish first, then this file.
--
-- SAFETY / IDEMPOTENCY:
--   * Matches the three entities by their stable slug PKs, verified to exist in
--     BOTH dev and prod: embracing_equity = Embracing Equity,
--     rising_tide = Rising Tide, tierra_indigena = Tierra Indigena. Re-running is
--     a no-op once set. (Earlier revisions used importer-era slugs n_equity /
--     n_indigena, which match no row in either environment — only rising_tide
--     got flagged — so the list was corrected to the live slugs.)
--   * Only ever SETS the flag to true for these three rows; never clears it and
--     never touches any other entity.
--   * If a slug differs in the target environment, adjust the id list below
--     (verify with the SELECT in the verification section first).
--
--   psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0059_entities_fiscally_sponsored.sql
--   (file is self-wrapped in BEGIN/COMMIT — do NOT add -1; use $DATABASE_URL for dev.)

BEGIN;

-- Pre-flight: confirm the three target entities exist by slug. (Informational —
-- the UPDATE below is still safe if a slug is missing; it just won't match.)
--   SELECT id, name, fiscally_sponsored FROM entities
--   WHERE id IN ('embracing_equity', 'rising_tide', 'tierra_indigena');

UPDATE entities
   SET fiscally_sponsored = true,
       updated_at = now()
 WHERE id IN ('embracing_equity', 'rising_tide', 'tierra_indigena')
   AND fiscally_sponsored IS DISTINCT FROM true;

-- Verification:
--   SELECT id, name, fiscally_sponsored FROM entities
--   WHERE id IN ('embracing_equity', 'rising_tide', 'tierra_indigena')
--   ORDER BY id;
--   -- Expect all three rows with fiscally_sponsored = true.

COMMIT;
