-- 0054_duplicate_dismissals
--
-- Backs the potential-duplicates review queue (C8). Records org/person pairs an
-- admin has explicitly marked "not a duplicate" so the detector never
-- re-surfaces them. See 0054_duplicate_dismissals_RUNBOOK.md.
--
-- Idempotent: safe to re-run. No data is modified; this only adds a new table.

CREATE TABLE IF NOT EXISTS duplicate_dismissals (
  id text PRIMARY KEY,
  entity_type text NOT NULL,
  id_a text NOT NULL,
  id_b text NOT NULL,
  dismissed_by_user_id text,
  dismissed_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT duplicate_dismissals_entity_type
    CHECK (entity_type IN ('organization', 'person')),
  CONSTRAINT duplicate_dismissals_ordered_pair
    CHECK (id_a < id_b)
);

CREATE UNIQUE INDEX IF NOT EXISTS duplicate_dismissals_pair_unique
  ON duplicate_dismissals (entity_type, id_a, id_b);
