-- Versioned grant-agreement review, append-only term outcomes, and manual
-- cumulative spend checkpoints. This is additive and safe to re-run because
-- every type, table, and index creation is guarded.
-- Human production apply (after Publish):
-- psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0258_grant_terms_workflow.sql
DO $$ BEGIN
  CREATE TYPE grant_term_set_source AS ENUM ('manual', 'grant_agreement', 'amendment');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE grant_term_set_status AS ENUM ('pending_review', 'active', 'superseded', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE grant_term_kind AS ENUM (
    'donor_restriction', 'condition', 'reporting_requirement',
    'payment_requirement', 'spending_rule', 'other_requirement'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE grant_restriction_dimension AS ENUM ('entity', 'geography', 'purpose', 'time', 'project', 'school');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE grant_spending_rule_type AS ENUM ('allowable_cost', 'prohibited_cost', 'cap', 'prior_approval');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE grant_term_outcome AS ENUM ('satisfied', 'missed', 'waived', 'reopened');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS grant_term_sets (
  id text PRIMARY KEY,
  opportunity_id text NOT NULL REFERENCES opportunities_and_pledges(id) ON DELETE RESTRICT,
  source grant_term_set_source NOT NULL,
  status grant_term_set_status NOT NULL,
  source_document_url text,
  source_document_filename text,
  analysis_summary text,
  ai_model text,
  prompt_version text,
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS grant_term_sets_opportunity_idx ON grant_term_sets(opportunity_id);
CREATE INDEX IF NOT EXISTS grant_term_sets_status_idx ON grant_term_sets(status);
CREATE UNIQUE INDEX IF NOT EXISTS grant_term_sets_one_active_per_opportunity_idx
  ON grant_term_sets(opportunity_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS grant_term_sets_one_pending_per_opportunity_idx
  ON grant_term_sets(opportunity_id) WHERE status = 'pending_review';

CREATE TABLE IF NOT EXISTS grant_terms (
  id text PRIMARY KEY,
  term_set_id text NOT NULL REFERENCES grant_term_sets(id) ON DELETE RESTRICT,
  pledge_allocation_id text REFERENCES pledge_allocations(id) ON DELETE SET NULL,
  expected_payment_id text REFERENCES pledge_expected_payments(id) ON DELETE SET NULL,
  kind grant_term_kind NOT NULL,
  restriction_dimension grant_restriction_dimension,
  spending_rule_type grant_spending_rule_type,
  title text NOT NULL,
  summary text NOT NULL,
  exact_quote text,
  source_page text,
  amount numeric(14,2),
  start_date date,
  end_date date,
  due_date date,
  barrier text,
  return_or_release_right text,
  consequence text,
  categories text[],
  cap_amount numeric(14,2),
  cap_percent numeric(7,4),
  sort_order numeric(8,0) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grant_terms_amount_nonnegative_chk CHECK (amount IS NULL OR amount >= 0),
  CONSTRAINT grant_terms_cap_amount_nonnegative_chk CHECK (cap_amount IS NULL OR cap_amount >= 0),
  CONSTRAINT grant_terms_cap_percent_range_chk CHECK (cap_percent IS NULL OR (cap_percent >= 0 AND cap_percent <= 1))
);

CREATE INDEX IF NOT EXISTS grant_terms_term_set_idx ON grant_terms(term_set_id);
CREATE INDEX IF NOT EXISTS grant_terms_allocation_idx ON grant_terms(pledge_allocation_id);
CREATE INDEX IF NOT EXISTS grant_terms_expected_payment_idx ON grant_terms(expected_payment_id);

CREATE TABLE IF NOT EXISTS grant_term_outcome_events (
  id text PRIMARY KEY,
  grant_term_id text NOT NULL REFERENCES grant_terms(id) ON DELETE RESTRICT,
  outcome grant_term_outcome NOT NULL,
  effective_date date NOT NULL,
  note text,
  evidence_url text,
  recorded_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS grant_term_outcome_events_term_idx
  ON grant_term_outcome_events(grant_term_id, created_at);

CREATE TABLE IF NOT EXISTS grant_spend_snapshots (
  id text PRIMARY KEY,
  pledge_allocation_id text NOT NULL REFERENCES pledge_allocations(id) ON DELETE RESTRICT,
  as_of_date date NOT NULL,
  amount_spent_to_date numeric(14,2) NOT NULL,
  note text,
  recorded_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grant_spend_snapshots_nonnegative_chk CHECK (amount_spent_to_date >= 0)
);

CREATE INDEX IF NOT EXISTS grant_spend_snapshots_allocation_idx
  ON grant_spend_snapshots(pledge_allocation_id, as_of_date, created_at);
