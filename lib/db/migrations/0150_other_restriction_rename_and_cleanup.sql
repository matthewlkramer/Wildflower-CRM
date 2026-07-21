-- 0150 — Rename the "usage" restriction axis to "other restriction", add the
-- free-text restriction_description column to both allocation tables, and clean
-- up existing restriction data.
--
-- Apply (human-run, from the repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0150_other_restriction_rename_and_cleanup.sql
--
-- No BEGIN/COMMIT in this file: psql -1 wraps the whole file in one transaction.
-- Idempotent: safe to re-run.
--
-- IMPORTANT ORDERING: run this file BEFORE clicking Publish. The guarded
-- RENAMEs below make the prod columns match the new schema, so the Publish
-- schema diff sees no rename (avoiding a destructive drop+add).
--
-- HARD GUARDRAIL: no row's derived restricted/unrestricted coding outcome
-- (anyDonorRestricted across the three axes) may flip. Verified at the end;
-- any flip aborts the whole transaction.

-- ── 1. Schema: guarded RENAME (never drop+add) + new nullable columns ──────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'gift_allocations' AND column_name = 'usage_restriction_type')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'gift_allocations' AND column_name = 'other_restriction_type') THEN
    ALTER TABLE gift_allocations RENAME COLUMN usage_restriction_type TO other_restriction_type;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'pledge_allocations' AND column_name = 'usage_restriction_type')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'pledge_allocations' AND column_name = 'other_restriction_type') THEN
    ALTER TABLE pledge_allocations RENAME COLUMN usage_restriction_type TO other_restriction_type;
  END IF;
END $$;

ALTER TABLE gift_allocations   ADD COLUMN IF NOT EXISTS restriction_description text;
ALTER TABLE pledge_allocations ADD COLUMN IF NOT EXISTS restriction_description text;

-- ── 2. Guardrail snapshot: anyDonorRestricted per allocation, BEFORE cleanup ─

CREATE TEMP TABLE _restr_before ON COMMIT DROP AS
SELECT 'gift'::text AS src, id,
       (regional_restriction_type = 'donor_restricted'
        OR other_restriction_type = 'donor_restricted'
        OR time_restriction_type  = 'donor_restricted') AS any_dr
FROM gift_allocations
UNION ALL
SELECT 'pledge', id,
       (regional_restriction_type = 'donor_restricted'
        OR other_restriction_type = 'donor_restricted'
        OR time_restriction_type  = 'donor_restricted')
FROM pledge_allocations;

-- ── 3a. Re-home purely geographic restrictions onto the regional axis ───────
-- Evidence rule (conservative): the row's purpose_verbatim exactly names a
-- known region. The regional axis is latched donor_restricted and the region
-- is appended BEFORE the other-axis latch is cleared, so anyDonorRestricted is
-- preserved by construction.

UPDATE gift_allocations a
SET regional_restriction_type = 'donor_restricted',
    region_ids = CASE
      WHEN a.region_ids IS NULL THEN ARRAY[r.id]
      WHEN NOT (r.id = ANY (a.region_ids)) THEN a.region_ids || r.id
      ELSE a.region_ids END,
    other_restriction_type = 'unrestricted',
    restriction_description = COALESCE(a.restriction_description, 'Restricted to region: ' || r.name),
    purpose_verbatim = NULL,
    updated_at = now()
FROM regions r
WHERE a.other_restriction_type = 'donor_restricted'
  AND a.purpose_verbatim IS NOT NULL
  AND lower(btrim(a.purpose_verbatim)) = lower(r.name);

UPDATE pledge_allocations a
SET regional_restriction_type = 'donor_restricted',
    region_ids = CASE
      WHEN a.region_ids IS NULL THEN ARRAY[r.id]
      WHEN NOT (r.id = ANY (a.region_ids)) THEN a.region_ids || r.id
      ELSE a.region_ids END,
    other_restriction_type = 'unrestricted',
    restriction_description = COALESCE(a.restriction_description, 'Restricted to region: ' || r.name),
    purpose_verbatim = NULL,
    updated_at = now()
FROM regions r
WHERE a.other_restriction_type = 'donor_restricted'
  AND a.purpose_verbatim IS NOT NULL
  AND lower(btrim(a.purpose_verbatim)) = lower(r.name);

-- ── 3b. Sort existing purpose_verbatim content ──────────────────────────────
-- Junk values are cleared outright; plain-language answers move to
-- restriction_description; genuine quoted/grant-letter language (contains a
-- quotation mark, or long-form >= 200 chars) stays in purpose_verbatim.

-- Junk clear (both tables).
UPDATE gift_allocations
SET purpose_verbatim = NULL, updated_at = now()
WHERE purpose_verbatim IS NOT NULL
  AND lower(btrim(purpose_verbatim)) IN
      ('', 'no', 'n/a', 'na', 'none', 'unrestricted', 'yes', '-', 'x', 'tbd', 'n a');

UPDATE pledge_allocations
SET purpose_verbatim = NULL, updated_at = now()
WHERE purpose_verbatim IS NOT NULL
  AND lower(btrim(purpose_verbatim)) IN
      ('', 'no', 'n/a', 'na', 'none', 'unrestricted', 'yes', '-', 'x', 'tbd', 'n a');

-- Plain-language answers → restriction_description (never overwrite an
-- existing description; quoted or long-form text stays verbatim).
UPDATE gift_allocations
SET restriction_description = btrim(purpose_verbatim),
    purpose_verbatim = NULL,
    updated_at = now()
WHERE purpose_verbatim IS NOT NULL
  AND restriction_description IS NULL
  AND position('"' IN purpose_verbatim) = 0
  AND position('“' IN purpose_verbatim) = 0
  AND length(btrim(purpose_verbatim)) < 200;

UPDATE pledge_allocations
SET restriction_description = btrim(purpose_verbatim),
    purpose_verbatim = NULL,
    updated_at = now()
WHERE purpose_verbatim IS NOT NULL
  AND restriction_description IS NULL
  AND position('"' IN purpose_verbatim) = 0
  AND position('“' IN purpose_verbatim) = 0
  AND length(btrim(purpose_verbatim)) < 200;

-- ── 3c. Backfill descriptions for BWF / school / project restricted rows ────
-- These keep their donor_restricted latch on the other axis (coding preserved);
-- they only gain a plain-language description where none exists. Evidence
-- precedence: BWF entity > specific school recipient > fundable project >
-- linked coding-form restriction language. Rows with no evidence are left
-- untouched (conservative).

UPDATE gift_allocations
SET restriction_description = 'Restricted to the Black Wildflowers Fund', updated_at = now()
WHERE other_restriction_type = 'donor_restricted'
  AND restriction_description IS NULL
  AND entity_id = 'black_wildflowers_fund';

UPDATE pledge_allocations
SET restriction_description = 'Restricted to the Black Wildflowers Fund', updated_at = now()
WHERE other_restriction_type = 'donor_restricted'
  AND restriction_description IS NULL
  AND entity_id = 'black_wildflowers_fund';

UPDATE gift_allocations
SET restriction_description = 'Restricted to direct support of a specific school', updated_at = now()
WHERE other_restriction_type = 'donor_restricted'
  AND restriction_description IS NULL
  AND school_recipient_id IS NOT NULL;

UPDATE pledge_allocations
SET restriction_description = 'Restricted to direct support of a specific school', updated_at = now()
WHERE other_restriction_type = 'donor_restricted'
  AND restriction_description IS NULL
  AND school_recipient_id IS NOT NULL;

UPDATE gift_allocations a
SET restriction_description = 'Restricted to project: ' || p.name, updated_at = now()
FROM fundable_projects p
WHERE a.other_restriction_type = 'donor_restricted'
  AND a.restriction_description IS NULL
  AND a.fundable_project_id = p.id;

UPDATE pledge_allocations a
SET restriction_description = 'Restricted to project: ' || p.name, updated_at = now()
FROM fundable_projects p
WHERE a.other_restriction_type = 'donor_restricted'
  AND a.restriction_description IS NULL
  AND a.fundable_project_id = p.id;

-- Coding-form evidence: the applied allocation's linked coding-form row holds
-- the reviewer-confirmed restriction language.
UPDATE gift_allocations a
SET restriction_description = btrim(c.restriction_language), updated_at = now()
FROM coding_form_rows c
WHERE a.other_restriction_type = 'donor_restricted'
  AND a.restriction_description IS NULL
  AND c.applied_allocation_id = a.id
  AND c.restriction_language IS NOT NULL
  AND btrim(c.restriction_language) <> ''
  AND lower(btrim(c.restriction_language)) NOT IN
      ('no', 'n/a', 'na', 'none', 'unrestricted', 'yes');

UPDATE pledge_allocations a
SET restriction_description = btrim(c.restriction_language), updated_at = now()
FROM coding_form_rows c
WHERE a.other_restriction_type = 'donor_restricted'
  AND a.restriction_description IS NULL
  AND c.applied_allocation_id = a.id
  AND c.restriction_language IS NOT NULL
  AND btrim(c.restriction_language) <> ''
  AND lower(btrim(c.restriction_language)) NOT IN
      ('no', 'n/a', 'na', 'none', 'unrestricted', 'yes');

-- ── 4. Guardrail verification: abort if any coding outcome flipped ──────────

DO $$
DECLARE
  flipped integer;
BEGIN
  SELECT count(*) INTO flipped
  FROM _restr_before b
  JOIN (
    SELECT 'gift'::text AS src, id,
           (regional_restriction_type = 'donor_restricted'
            OR other_restriction_type = 'donor_restricted'
            OR time_restriction_type  = 'donor_restricted') AS any_dr
    FROM gift_allocations
    UNION ALL
    SELECT 'pledge', id,
           (regional_restriction_type = 'donor_restricted'
            OR other_restriction_type = 'donor_restricted'
            OR time_restriction_type  = 'donor_restricted')
    FROM pledge_allocations
  ) a ON a.src = b.src AND a.id = b.id
  WHERE a.any_dr IS DISTINCT FROM b.any_dr;

  IF flipped > 0 THEN
    RAISE EXCEPTION
      'Restriction cleanup would flip the coding outcome of % allocation row(s) — aborting.',
      flipped;
  END IF;
END $$;
