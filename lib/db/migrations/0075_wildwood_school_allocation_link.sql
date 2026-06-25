-- 0075_wildwood_school_allocation_link.sql
--
-- Purpose: link the Stranahan FY2021 $30,000 allocation to the Wildwood
-- Montessori school by setting gift_allocations.school_recipient_id.
--   * gift:        recwKC3JHKRY2QYHe
--   * allocation:  ga-stranahan-fy21-wildwood  (sub_amount 30000.00)
--   * school:      rec5wLfcIiuFSJCj1  ("Wildwood" / "Wildwood Montessori")
--
-- Why the school is inserted here too:
--   Wildwood is a permanently-closed school. It exists in the Airtable "Schools"
--   source (and in dev), but is not yet in prod's schools table. The allocation
--   link cannot be set until that school row exists, because
--   gift_allocations.school_recipient_id -> schools.id is ON DELETE RESTRICT.
--   So this file first inserts the school idempotently, then links the
--   allocation. This makes the file self-contained: it works whether or not the
--   scheduled prod Airtable school sync has already created the row.
--
-- Idempotent + non-destructive:
--   * The school INSERT uses ON CONFLICT (id) DO NOTHING, so it is a no-op if the
--     row already exists. The scheduled sync uses onConflictDoUpdate, so it will
--     reconcile this row to authoritative Airtable values on its next run.
--   * The allocation UPDATE is guarded by school_recipient_id IS NULL, so
--     re-running never overwrites a later or different link.
--
-- Apply (human, from repo root). Do NOT wrap in BEGIN/COMMIT — the -1 flag runs
-- the whole file in a single transaction:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0075_wildwood_school_allocation_link.sql

-- 1. Ensure the Wildwood school row exists (no-op if already present/synced).
INSERT INTO schools (
  id, name, long_name, short_name, status, governance_model, ages_planes, stage_status
)
VALUES (
  'rec5wLfcIiuFSJCj1',
  'Wildwood',
  'Wildwood Montessori',
  'Wildwood',
  'permanently_closed',
  'independent',
  ARRAY['recpVMWtIy3m9IhZ9', 'recEDAFOaBzJMRqSz', 'recF6KhKauIMuadX4'],
  'Permanently Closed'
)
ON CONFLICT (id) DO NOTHING;

-- 2. Link the allocation to Wildwood (only if not already linked).
UPDATE gift_allocations
   SET school_recipient_id = 'rec5wLfcIiuFSJCj1'
 WHERE id = 'ga-stranahan-fy21-wildwood'
   AND school_recipient_id IS NULL;

-- 3. Verification (read-only — prints the linked allocation + school name).
SELECT ga.id            AS allocation_id,
       ga.gift_id,
       ga.sub_amount,
       ga.school_recipient_id,
       s.name           AS school_name,
       s.status         AS school_status
  FROM gift_allocations ga
  LEFT JOIN schools s ON s.id = ga.school_recipient_id
 WHERE ga.id = 'ga-stranahan-fy21-wildwood';
