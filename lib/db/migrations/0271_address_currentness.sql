-- Preserve historical addresses instead of deleting or overwriting them.
-- Existing addresses stay current until reviewed by staff.
-- Safe to rerun: the column add is guarded and the reviewed update only
-- affects Emma's still-current Bentonville address.
-- Apply from the repo root after Publish:
-- psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0271_address_currentness.sql
ALTER TABLE addresses
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;

-- Emma's Bentonville mailing address was identified as historical in the
-- Sep 30 feedback. Keep the address for provenance, but stop treating it as
-- her current location; her Boston home region remains unchanged.
UPDATE addresses
SET is_current = false, updated_at = NOW()
WHERE person_id = 'recIsNvUupLI35V20'
  AND lower(btrim(city)) = 'bentonville'
  AND is_current = true;
