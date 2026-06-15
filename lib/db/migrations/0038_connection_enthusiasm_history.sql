-- Migration 0038: connection_enthusiasm_history
-- Audit trail for connectionStatus / enthusiasm changes on people and organizations.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS connection_enthusiasm_history (
  id                  TEXT        PRIMARY KEY,
  entity_type         TEXT        NOT NULL,
  entity_id           TEXT        NOT NULL,
  field               TEXT        NOT NULL,
  from_value          TEXT,
  to_value            TEXT,
  changed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by_user_id  TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS ceh_entity_idx
  ON connection_enthusiasm_history (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS ceh_changed_at_idx
  ON connection_enthusiasm_history (changed_at);

CREATE INDEX IF NOT EXISTS ceh_user_idx
  ON connection_enthusiasm_history (changed_by_user_id);
