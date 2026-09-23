-- 0262: Canonical conference/event attendance, staged imports, and review suggestions.
-- Additive. No production data is seeded by this migration.

CREATE TABLE IF NOT EXISTS conference_types (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}'::text[],
  organizer text,
  website_url text,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS conference_types_display_name_uq ON conference_types(display_name);

CREATE TABLE IF NOT EXISTS conference_events (
  id text PRIMARY KEY,
  conference_type_id text NOT NULL REFERENCES conference_types(id) ON DELETE RESTRICT,
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  name_override text,
  start_date date,
  end_date date,
  location text,
  attendee_site_url text,
  source text,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'completed', 'cancelled')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conference_type_id, year)
);
CREATE INDEX IF NOT EXISTS conference_events_type_idx ON conference_events(conference_type_id);

CREATE TABLE IF NOT EXISTS conference_import_batches (
  id text PRIMARY KEY,
  conference_event_id text NOT NULL REFERENCES conference_events(id) ON DELETE CASCADE,
  source_hash text NOT NULL,
  source_filename text,
  status text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'confirmed')),
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conference_event_id, source_hash)
);
CREATE INDEX IF NOT EXISTS conference_import_batches_event_idx ON conference_import_batches(conference_event_id);

CREATE TABLE IF NOT EXISTS conference_import_rows (
  id text PRIMARY KEY,
  conference_import_batch_id text NOT NULL REFERENCES conference_import_batches(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  raw_name text,
  raw_email text,
  raw_organization text,
  match_status text NOT NULL CHECK (match_status IN ('exact', 'ambiguous', 'unmatched')),
  matched_person_id text REFERENCES people(id) ON DELETE SET NULL,
  match_evidence text,
  reviewed_person_id text REFERENCES people(id) ON DELETE SET NULL,
  disposition text NOT NULL DEFAULT 'pending' CHECK (disposition IN ('pending', 'accept', 'skip')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conference_import_batch_id, row_number)
);
CREATE INDEX IF NOT EXISTS conference_import_rows_batch_idx ON conference_import_rows(conference_import_batch_id);
CREATE INDEX IF NOT EXISTS conference_import_rows_person_idx ON conference_import_rows(matched_person_id);

CREATE TABLE IF NOT EXISTS conference_attendance (
  id text PRIMARY KEY,
  conference_event_id text NOT NULL REFERENCES conference_events(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'likely', 'possible')),
  source_type text NOT NULL DEFAULT 'manual' CHECK (source_type IN ('uploaded_list', 'conference_website', 'wildflower_email', 'manual')),
  source_reference text,
  evidence_note text,
  organization_snapshot text,
  matched_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  imported_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conference_event_id, person_id)
);
CREATE INDEX IF NOT EXISTS conference_attendance_person_idx ON conference_attendance(person_id);
CREATE INDEX IF NOT EXISTS conference_attendance_event_idx ON conference_attendance(conference_event_id);

CREATE TABLE IF NOT EXISTS conference_attendance_suggestions (
  id text PRIMARY KEY,
  conference_event_id text NOT NULL REFERENCES conference_events(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  email_message_id text,
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  evidence_note text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
  reviewed_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT(conference_event_id, person_id, email_message_id)
);
CREATE INDEX IF NOT EXISTS conference_attendance_suggestions_event_idx ON conference_attendance_suggestions(conference_event_id, status);

CREATE TABLE IF NOT EXISTS conference_research_requests (
  id text PRIMARY KEY,
  conference_event_id text NOT NULL REFERENCES conference_events(id) ON DELETE CASCADE,
  attendee_site_url text,
  instructions text,
  prompt text NOT NULL,
  status text NOT NULL DEFAULT 'drafted',
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conference_research_requests_event_idx ON conference_research_requests(conference_event_id);

INSERT INTO conference_types (id, display_name, aliases, active)
VALUES
  ('conference_type_gfe', 'Grantmakers for Education Annual Conference', ARRAY['Grantmakers for Education', 'GFE Annual Conference'], true),
  ('conference_type_asu_gsv', 'ASU+GSV Summit', ARRAY['ASU-GSV', 'ASU GSV'], true),
  ('conference_type_newschools', 'NewSchools Summit', ARRAY['NewSchools'], true),
  ('conference_type_yass', 'Yass Prize', ARRAY['Yass'], true),
  ('conference_type_csgf', 'Charter School Growth Fund CEO Conference', ARRAY['CSGF CEO Conference'], true),
  ('conference_type_napcs', 'National Alliance for Public Charter Schools Annual Conference', ARRAY['NAPCS', 'National Charter Schools Conference'], true),
  ('conference_type_sxsw_edu', 'SXSW EDU', ARRAY['SXSW Education'], true),
  ('conference_type_edufish', 'Bellwether eduFish', ARRAY['eduFish'], true),
  ('conference_type_dialog', 'Dialog Retreat', ARRAY['Dialog'], true)
ON CONFLICT (id) DO UPDATE
SET display_name = EXCLUDED.display_name, aliases = EXCLUDED.aliases, active = true, updated_at = now();