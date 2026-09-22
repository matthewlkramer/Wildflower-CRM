-- 0261: Enrichment review queue fields and normalized organization EIN.
-- Additive and idempotent. No canonical data or suggestions are written.

ALTER TABLE enrichment_suggestions
  ADD COLUMN IF NOT EXISTS confidence text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'enrichment_suggestions_confidence_ck'
      AND conrelid = 'enrichment_suggestions'::regclass
  ) THEN
    ALTER TABLE enrichment_suggestions
      ADD CONSTRAINT enrichment_suggestions_confidence_ck
      CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS enrichment_suggestions_confidence_idx
  ON enrichment_suggestions(confidence);

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ein text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_ein_format_ck'
      AND conrelid = 'organizations'::regclass
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_ein_format_ck
      CHECK (ein IS NULL OR ein ~ '^[0-9]{2}-[0-9]{7}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_ein_uq
  ON organizations(ein) WHERE ein IS NOT NULL;