-- 0154 — Reclassify grouping-style parent links into memberships; derive display_path
--
-- Idempotent. Requires 0153 (region_memberships / region_aliases). Apply with:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0154_reclassify_region_groupings.sql
-- (No BEGIN/COMMIT here — psql -1 wraps the file in one transaction.)
--
-- 1. Every region whose parent is a GROUPING region (multi_state_region or
--    metro_area) is reparented to that grouping's nearest NATURAL ancestor
--    (state → country → continent chain), and the old grouping link is
--    preserved as a region_memberships row. Examples:
--      Great Lakes Region → Illinois/…    (states reparent to United States)
--      Greater Boston → Boston/…          (cities reparent to Massachusetts)
--    This also repairs corrupt links like region_within_state rows parented
--    to a metro.
-- 2. Connecticut joins the New England membership set (it was parented to
--    united_states directly, so step 1 never created its membership).
-- 3. display_path becomes fully DERIVED from canonical parentage:
--    comma-joined names root → self, recomputed for every region.
-- 4. Seed common search aliases (DC, NYC, Twin Cities region shorthands).

-- ── 1. Convert grouping parent links to memberships ─────────────────────────
-- Record the membership edge before rewriting the parent pointer.
INSERT INTO region_memberships (id, container_region_id, member_region_id)
SELECT 'rm_' || md5(p.id || '→' || c.id), p.id, c.id
FROM regions c
JOIN regions p ON p.id = c.parent_region_id
WHERE p.type IN ('multi_state_region', 'metro_area')
ON CONFLICT (container_region_id, member_region_id) DO NOTHING;

-- Reparent: nearest natural ancestor of the grouping (walk up through any
-- consecutive grouping layers; stop at the first non-grouping ancestor).
WITH RECURSIVE natural_anchor AS (
  -- start: each region whose parent is a grouping
  SELECT c.id AS child_id, p.parent_region_id AS candidate_id, 1 AS depth
  FROM regions c
  JOIN regions p ON p.id = c.parent_region_id
  WHERE p.type IN ('multi_state_region', 'metro_area')
  UNION ALL
  -- keep climbing while the candidate is itself a grouping
  SELECT na.child_id, cand.parent_region_id, na.depth + 1
  FROM natural_anchor na
  JOIN regions cand ON cand.id = na.candidate_id
  WHERE cand.type IN ('multi_state_region', 'metro_area') AND na.depth < 10
),
resolved AS (
  SELECT DISTINCT ON (na.child_id) na.child_id, na.candidate_id
  FROM natural_anchor na
  LEFT JOIN regions cand ON cand.id = na.candidate_id
  WHERE na.candidate_id IS NULL
     OR cand.type IS NULL
     OR cand.type NOT IN ('multi_state_region', 'metro_area')
  ORDER BY na.child_id, na.depth
)
UPDATE regions r
SET parent_region_id = resolved.candidate_id, updated_at = now()
FROM resolved
WHERE r.id = resolved.child_id
  AND r.parent_region_id IS DISTINCT FROM resolved.candidate_id;

-- ── 2. Connecticut belongs to New England ────────────────────────────────────
INSERT INTO region_memberships (id, container_region_id, member_region_id)
SELECT 'rm_' || md5(p.id || '→' || c.id), p.id, c.id
FROM regions p, regions c
WHERE p.id = 'united_states__new_england' AND c.id = 'united_states__connecticut'
ON CONFLICT (container_region_id, member_region_id) DO NOTHING;

-- ── 3. Recompute display_path from canonical parentage for ALL regions ──────
WITH RECURSIVE paths AS (
  SELECT id, name, parent_region_id, name::text AS path, 1 AS depth
  FROM regions
  WHERE parent_region_id IS NULL
  UNION ALL
  SELECT r.id, r.name, r.parent_region_id, p.path || ', ' || r.name, p.depth + 1
  FROM regions r
  JOIN paths p ON p.id = r.parent_region_id
  WHERE p.depth < 12
)
UPDATE regions r
SET display_path = paths.path, updated_at = now()
FROM paths
WHERE r.id = paths.id AND r.display_path IS DISTINCT FROM paths.path;

-- ── 4. Seed common aliases ───────────────────────────────────────────────────
INSERT INTO region_aliases (id, region_id, alias)
SELECT 'ra_' || md5(v.region_id || '→' || lower(v.alias)), v.region_id, v.alias
FROM (VALUES
  ('united_states__maryland__washington_d_c', 'DC'),
  ('united_states__maryland__washington_d_c', 'Washington DC'),
  ('united_states__maryland__dc_metro_area', 'DMV'),
  ('united_states__new_york_state__new_york_city_5_borroughs', 'NYC'),
  ('united_states__new_york_state__new_york_city_5_borroughs', 'New York City'),
  ('united_states__new_york_state__new_york_manhattan', 'Manhattan'),
  ('united_states__minnesota__twin_cities', 'Minneapolis-St. Paul'),
  ('united_states__california__san_francisco', 'SF'),
  ('united_states__california__bay_area', 'San Francisco Bay Area')
) AS v(region_id, alias)
WHERE EXISTS (SELECT 1 FROM regions r WHERE r.id = v.region_id)
ON CONFLICT (region_id, lower(alias)) DO NOTHING;
