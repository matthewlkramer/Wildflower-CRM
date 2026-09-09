-- Trip planner schema. Idempotent and additive.
-- Apply from repository root:
-- psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0235_trip_planner.sql

CREATE TABLE IF NOT EXISTS trip_plans (
  id text PRIMARY KEY,
  traveler_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title text,
  destination_city text,
  destination_state text,
  travel_starts_at timestamptz NOT NULL,
  travel_ends_at timestamptz NOT NULL,
  meeting_window_starts_at timestamptz,
  meeting_window_ends_at timestamptz,
  outbound_travel_minutes integer,
  return_travel_minutes integer,
  notes text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_plans_positive_window CHECK (travel_ends_at > travel_starts_at),
  CONSTRAINT trip_plans_meeting_window_pair CHECK (
    (meeting_window_starts_at IS NULL) = (meeting_window_ends_at IS NULL)
  ),
  CONSTRAINT trip_plans_meeting_window_inside_trip CHECK (
    meeting_window_starts_at IS NULL OR (
      meeting_window_starts_at >= travel_starts_at
      AND meeting_window_ends_at <= travel_ends_at
      AND meeting_window_ends_at > meeting_window_starts_at
    )
  ),
  CONSTRAINT trip_plans_outbound_minutes_nonnegative CHECK (
    outbound_travel_minutes IS NULL OR outbound_travel_minutes >= 0
  ),
  CONSTRAINT trip_plans_return_minutes_nonnegative CHECK (
    return_travel_minutes IS NULL OR return_travel_minutes >= 0
  )
);

CREATE INDEX IF NOT EXISTS trip_plans_traveler_start_idx
  ON trip_plans (traveler_user_id, travel_starts_at);
CREATE INDEX IF NOT EXISTS trip_plans_archived_at_idx
  ON trip_plans (archived_at);

CREATE TABLE IF NOT EXISTS trip_visit_candidates (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES trip_plans(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  rank integer NOT NULL,
  rationale text,
  source text NOT NULL,
  notes text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_visit_candidates_trip_person_uq UNIQUE (trip_id, person_id),
  CONSTRAINT trip_visit_candidates_rank_positive CHECK (rank >= 1),
  CONSTRAINT trip_visit_candidates_source_check CHECK (
    source IN ('system_draft', 'manual')
  )
);

CREATE INDEX IF NOT EXISTS trip_visit_candidates_trip_rank_idx
  ON trip_visit_candidates (trip_id, rank);
CREATE INDEX IF NOT EXISTS trip_visit_candidates_person_idx
  ON trip_visit_candidates (person_id);
