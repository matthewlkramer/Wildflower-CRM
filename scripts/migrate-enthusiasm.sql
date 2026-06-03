-- One-time migration: rename enthusiasm enum values to 7-point numbered scale.
-- Safe to re-run (DO blocks guard each step).
-- Already executed 2026-06-03. Kept here for reference / re-import scenarios.

DO $$
DECLARE
  labels text[];
BEGIN
  SELECT array_agg(enumlabel) INTO labels
  FROM pg_enum
  WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'enthusiasm');

  IF 'advocate' = ANY(labels) AND NOT '7-advocate' = ANY(labels) THEN
    ALTER TYPE enthusiasm RENAME VALUE 'advocate' TO '7-advocate';
  END IF;

  IF 'supportive' = ANY(labels) AND NOT '6-supportive' = ANY(labels) THEN
    ALTER TYPE enthusiasm RENAME VALUE 'supportive' TO '6-supportive';
  END IF;

  IF 'warm' = ANY(labels) AND NOT '5-warm' = ANY(labels) THEN
    ALTER TYPE enthusiasm RENAME VALUE 'warm' TO '5-warm';
  END IF;

  IF 'neutral' = ANY(labels) AND NOT '4-neutral' = ANY(labels) THEN
    ALTER TYPE enthusiasm RENAME VALUE 'neutral' TO '4-neutral';
  END IF;

  IF 'unsupportive' = ANY(labels) AND NOT '2-unsupportive' = ANY(labels) THEN
    ALTER TYPE enthusiasm RENAME VALUE 'unsupportive' TO '2-unsupportive';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'enthusiasm')
    AND enumlabel = '1-hostile'
  ) THEN
    ALTER TYPE enthusiasm ADD VALUE '1-hostile';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'enthusiasm')
    AND enumlabel = '3-cool'
  ) THEN
    ALTER TYPE enthusiasm ADD VALUE '3-cool';
  END IF;
END
$$;
