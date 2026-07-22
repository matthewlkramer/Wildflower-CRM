-- 0151 — Rename stored coding-form attribute keys inside the `decisions` and
-- `overrides` JSONB columns on coding_form_rows, following the settled
-- restriction model (migrations 0147/0150):
--   "purposeVerbatim"  → "restrictionDescription"  (the key always wrote the
--                        plain-language restriction_description field; the key
--                        name now matches the field it targets. A NEW
--                        "purposeVerbatim" attribute — writing the verbatim
--                        purpose_verbatim field — starts fresh with no stored
--                        decisions, so it must NOT inherit the old key.)
--   "usageRestriction" → "otherRestriction"        (column was renamed
--                        usage_restriction_type → other_restriction_type in 0150)
--
-- Apply (human-run, from the repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0151_coding_form_attribute_key_rename.sql
--
-- No BEGIN/COMMIT in this file: psql -1 wraps the whole file in one transaction.
-- Idempotent: each statement is guarded by `? old_key`, and re-running after
-- the rename finds no old keys to move.

-- decisions: purposeVerbatim → restrictionDescription
UPDATE coding_form_rows
SET decisions = (decisions - 'purposeVerbatim')
      || jsonb_build_object('restrictionDescription', decisions->'purposeVerbatim'),
    updated_at = now()
WHERE decisions ? 'purposeVerbatim';

-- decisions: usageRestriction → otherRestriction
UPDATE coding_form_rows
SET decisions = (decisions - 'usageRestriction')
      || jsonb_build_object('otherRestriction', decisions->'usageRestriction'),
    updated_at = now()
WHERE decisions ? 'usageRestriction';

-- overrides: purposeVerbatim → restrictionDescription
UPDATE coding_form_rows
SET overrides = (overrides - 'purposeVerbatim')
      || jsonb_build_object('restrictionDescription', overrides->'purposeVerbatim'),
    updated_at = now()
WHERE overrides ? 'purposeVerbatim';

-- overrides: usageRestriction → otherRestriction
UPDATE coding_form_rows
SET overrides = (overrides - 'usageRestriction')
      || jsonb_build_object('otherRestriction', overrides->'usageRestriction'),
    updated_at = now()
WHERE overrides ? 'usageRestriction';
