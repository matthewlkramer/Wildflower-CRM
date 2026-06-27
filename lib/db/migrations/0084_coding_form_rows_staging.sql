-- Migration 0084: One-time "Donation Revenue Coding Form" import — staging table.
--
-- WHY:
--   We are importing ~288 rows from the Wildflower donation coding-form exports
--   (FY24 / FY25 / FY26 Google Form responses + the Girasol / Act-60 sheet) and
--   reconciling each row against the live CRM (donor + opportunity/pledge/gift,
--   per-attribute cross-check, admin-reviewed apply). The import-review workflow
--   needs a durable staging home: `coding_form_rows`. It carries the raw
--   captured values, the proposed/confirmed match (plain-text donor ids — Donor
--   XOR is enforced in the API at match/apply time, NOT by a DB CHECK, because a
--   row may legitimately have ZERO matches), the reviewer's per-attribute
--   decisions, and the applied-state pointers that make re-applying idempotent.
--   The cross-check itself (new/same/conflict) is computed LIVE on read, never
--   stored, so it can never go stale.
--
-- WHAT THIS FILE DOES:
--   1. CREATE TYPE coding_form_row_status (idempotent via DO/exception guard).
--   2. CREATE TABLE IF NOT EXISTS coding_form_rows + its indexes.
--   This file creates NOTHING destructive and seeds NO data.
--
-- PUBLISH ORDERING (invariant #7): the enum + table also reach prod through the
--   normal Publish (drizzle) diff. This file is the self-contained, idempotent
--   equivalent (mirrors the 0080 "make the file safe whether or not Publish has
--   already applied the schema" pattern) so it can be run before/after Publish
--   with the same result. ROW SEEDING is a separate operator step — see the
--   companion RUNBOOK; rows come from parsing the source spreadsheets via the
--   `import:coding-forms` script, not from this SQL file.
--
-- IDEMPOTENCY / SAFETY:
--   * Re-running is a no-op: the enum guard swallows duplicate_object and the
--     table/indexes are all IF NOT EXISTS.
--   * NOTHING is dropped. This is purely additive staging infrastructure.
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0084_coding_form_rows_staging.sql
--
-- Run with `-1` (psql wraps the whole file in ONE transaction). Do NOT add an
-- internal BEGIN/COMMIT — `-1` already provides the single-transaction guarantee.

-- ─── 1. Enum (idempotent) ──────────────────────────────────────────────────
DO $$
BEGIN
  CREATE TYPE coding_form_row_status AS ENUM ('pending', 'applied', 'skipped');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ─── 2. Staging table (idempotent) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coding_form_rows (
  -- Deterministic id `cfr_<source>_<rowIndex>` so re-importing is idempotent.
  id                          text PRIMARY KEY,
  source                      text NOT NULL,
  source_row_index            integer NOT NULL,

  -- 1. Raw captured values (read-only provenance).
  raw_data                    jsonb NOT NULL,
  donor_name_raw              text,
  internal_memo               text,
  donor_type_raw              text,
  series_type_raw             text,
  restriction_language        text,
  donor_name_address_raw      text,
  report_required_raw         text,
  drive_link                  text,
  circle_raw                  text,
  additional_notes            text,
  payment_method_raw          text,
  stripe_fees_raw             text,
  class_raw                   text,
  submitter_email             text,
  wildflower_partner          text,

  -- 2. Normalized scalars.
  amount                      numeric(14, 2),
  donation_date               date,
  deposit_date                date,
  addr_street                 text,
  addr_city                   text,
  addr_state                  text,
  addr_postal                 text,
  addr_country                text,
  report_required             boolean,
  report_due_date             date,
  intended_usage_suggested    intended_usage,

  -- 3. Proposed / confirmed match (plain text, app-layer Donor XOR).
  organization_id             text,
  individual_giver_person_id  text,
  household_id                text,
  matched_opportunity_id      text,
  matched_gift_id             text,
  match_score                 integer,
  match_method                text,
  match_tier                  text,
  match_confirmed_at          timestamp,
  match_confirmed_by_user_id  text,

  -- 4. Reviewer decisions ({ [attribute]: 'apply' | 'skip' }).
  decisions                   jsonb NOT NULL DEFAULT '{}',

  -- 5. Applied state (idempotency).
  status                      coding_form_row_status NOT NULL DEFAULT 'pending',
  applied_at                  timestamp,
  applied_by_user_id          text,
  applied_task_id             text,
  applied_address_id          text,
  applied_allocation_id       text,

  created_at                  timestamp NOT NULL DEFAULT now(),
  updated_at                  timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS coding_form_rows_source_row_unique
  ON coding_form_rows (source, source_row_index);
CREATE INDEX IF NOT EXISTS coding_form_rows_status_idx
  ON coding_form_rows (status);
CREATE INDEX IF NOT EXISTS coding_form_rows_source_idx
  ON coding_form_rows (source);
CREATE INDEX IF NOT EXISTS coding_form_rows_organization_id_idx
  ON coding_form_rows (organization_id);
CREATE INDEX IF NOT EXISTS coding_form_rows_person_id_idx
  ON coding_form_rows (individual_giver_person_id);
CREATE INDEX IF NOT EXISTS coding_form_rows_household_id_idx
  ON coding_form_rows (household_id);

-- ─── 3. Operator report (non-aborting) ─────────────────────────────────────
DO $$
DECLARE
  n_rows int;
BEGIN
  SELECT count(*) INTO n_rows FROM coding_form_rows;
  RAISE NOTICE '0084: coding_form_rows ready; current row count=% (seed via import:coding-forms — see RUNBOOK)', n_rows;
END $$;
